/**
 * Lane Work Queue — accessible to all roles
 *
 * Shows eligible recurring lanes bucketed into four operational states:
 *   1. Unassigned        — no owner yet
 *   2. No Contactable    — assigned but 0 carriers have phone/email
 *   3. Assigned Untouched — assigned + contactable, 0 contacted so far
 *   4. In Progress       — 1+ contacted, not yet complete
 *
 * Managers see their full team-level view; other users see only their own lanes.
 * Clicking a row opens CarrierOutreachPanel for immediate action.
 *
 * Cross-cutting filter / selection / outreach contracts shared with
 * Available Freight and Available Loads live in docs/workflow-os-spec.md.
 * Read it before changing the filter bar, selection grammar, bulk action
 * bar, or guardrail copy.
 */

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useLocation, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { CrossTabBreadcrumb } from "@/components/freight/cross-tab-breadcrumb";
import { ContextNotePopover, useRevealContextNoteRow } from "@/components/context-notes";
import { EmbeddedPlayCard } from "@/components/dna-copilot/embedded-play-card";
import { formatLaneDisplay, formatWeeklyLoadRange, formatCustomerName } from "@shared/laneFormatters";
import { Badge } from "@/components/ui/badge";
import { UnifiedUploadFreshnessPill } from "@/components/freight/unified-upload-freshness-pill";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Truck,
  AlertCircle,
  CheckCircle2,
  User,
  UserX,
  Mail,
  Phone,
  ChevronRight,
  Loader2,
  RefreshCw,
  ListFilter,
  Zap,
  Eye,
  ChevronDown,
  Building2,
  Filter,
  Database,
  PlusCircle,
  Shield,
  TrendingUp,
  MessageCircle,
  X,
  MoreHorizontal,
  Clock,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CarrierOutreachPanel } from "@/components/CarrierOutreachPanel";
import { LiveOppsChip } from "@/components/freight/lane-cross-link-chip";
// Task #1030 — FreshnessPill moved off LWQ to /admin/lane-engine. The
// LWQ header now renders a small `status-engine-health` dot instead.
import { HiddenCountsDisclosure, type HiddenCountsSummary } from "@/components/freight/hidden-counts";
// Task #967 — shared live-sync health pill.
import { LiveSyncPill } from "@/components/live-sync/LiveSyncPill";
import { LaneCockpitSheet } from "@/components/lane-cockpit/lane-cockpit-sheet";
import {
  useSharedLaneKeyboard,
  useLaneCheatSheetRows,
} from "@/hooks/useSharedLaneKeyboard";
import { laneStoryHref } from "@/lib/laneSignature";
import { AccountSharingDialog } from "@/components/lane-work-queue/AccountSharingDialog";
import { SendReplyAuditPanel } from "@/components/lane-work-queue/SendReplyAuditPanel";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@tanstack/react-query";
import { InfoTooltip } from "@/components/info-tooltip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  resolveLaneLocationWithConfidence,
  normalizeStateAbbr,
} from "@/lib/laneLocationNormalizer";
import { LaneLocationFeedback as LocationFeedback, EMPTY_NORM_STATE, type FieldNormState } from "@/components/lane-location-feedback";
import { CityAutocompleteInput } from "@/components/city-autocomplete-input";
import {
  getCachedRowHeight,
  setCachedRowHeight,
  LWQ_VIEWPORT_MARGIN_PX,
} from "@/lib/lwq-virtualization";
import {
  useLaneSignals,
  useCachedLaneSignals,
  laneSigKey,
  type LaneSignalResult,
} from "@/hooks/useLaneSignals";
// Workflow OS — shared primitives. See docs/workflow-os-spec.md sections A–G.
// Owner filter, pickup scope, stale-count chip, bulk action bar, row
// selection, and the URL ↔ filters round-trip helpers all live behind these
// re-exports so AF, LWQ, and Available Loads share one contract.
import { OwnerFilterSelect } from "@/components/workflow-os/OwnerFilterSelect";
import { PickupScopeSelect } from "@/components/workflow-os/PickupScopeSelect";
import { StaleCountChip } from "@/components/workflow-os/StaleCountChip";
import {
  BulkActionBar,
  type BulkAction,
  type BulkActionAvailability,
} from "@/components/workflow-os/BulkActionBar";
import { useRowSelection } from "@/hooks/workflow-os/useRowSelection";
import { fetchWithFreshnessGuard } from "@/lib/queryFreshness";
import { runWithUndo } from "@/lib/workflow-os/withUndo";
import { useShortcutTarget } from "@/hooks/useShortcutTarget";
import {
  canAssignLane,
  summarizeBulkAssign,
  ASSIGNABLE_OUTREACH_ROLES,
  type AssignableOutreachRole,
} from "@/lib/workflow-os/canAssignLane";
import {
  serializeFiltersToUrl,
  deserializeFiltersFromUrl,
  myWorkTodayView,
  type SharedFilters,
} from "@/lib/workflow-os/savedViews";
import {
  type PickupScopeValue,
  DEFAULT_PICKUP_SCOPE,
  type PickupFreshness,
} from "@shared/workflowOs/actionability";
import { type OwnerFilterValue } from "@shared/workflowOs/ownership";
import { Sparkles } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CoverageProfile {
  id: string;
  coverageStatus: string;
  sampleSize: number;
  qualifiedCarrierCount: number;
  topCarrierCoverageShare: string | null;
  manualOverrideStatus: string | null;
  broadenSearchActive: boolean;
}

interface CoverageProfileCarrier {
  carrierName: string;
  incumbentRank: number;
  successfulLoadCount: number;
  recentLoadCount: number;
  coverageShare: string | null;
  lastUsedAt: string | null;
  isCurrentPrimary: boolean;
}

interface LaneReplySummary {
  totalReplied: number;
  hotCount: number;
  topStatus: string | null;
  topCarrierName: string | null;
  needsAction: boolean;  // hot reply exists AND no open follow-up task yet
}

interface LaneItem {
  laneId: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  avgLoadsPerWeek: string | null;
  laneScore: number | null;
  companyId: string | null;
  companyName: string | null;
  carriersContactedCount: number;
  ownerUserId: string | null;
  ownerName: string | null;
  contactableCount: number;
  totalBenchCount: number;
  historicalCount: number;
  missingContactCount: number;
  isHighFrequency?: boolean;
  isManual?: boolean;
  /** Task #635 — joined from server in the same payload (no per-row N+1). */
  liveOpps?: {
    laneSignature: string;
    count: number;
    totalLoads: number;
    combinedRevenue: number;
    nextPickupAt: string | null;
    sampleOppId: string | null;
    /** Task #1069 — subset of `count` from won customer quotes. */
    wonQuoteCount: number;
  } | null;
  // Workflow OS — server-stamped Task #917. The lane itself has no pickup
  // column; freshness is derived from `liveOpps.nextPickupAt` on the server
  // so the actionable scope answer matches the canonical predicate.
  pickupFreshness?: PickupFreshness;
  pickupDaysAgo?: number | null;
  status?: "unassigned" | "noContactable" | "assignedUntouched" | "inProgress";
  pickupWindowStart?: string | null;
  // Task #1028 (LWQ C) — Outreach mode reply-urgency. Server attaches when
  // `?mode=outreach`; absent in other modes so the field stays opt-in.
  hotReplyCount?: number;
  // Task #1027 (LWQ B) — strategic priority composite. Server attaches when
  // `?sort=strategic` is set OR when `?mode=outreach` (Task #1029) so the
  // row's strategic-tier reason chip can render across both surfaces.
  strategicPriority?: number;
  priorityExplanation?: {
    score: number;
    components: Array<{ label: string; score: number; contribution: number }>;
    /** Label of the highest-contributing component — drives the row reason chip. */
    topReason: string;
  };
  // Task #1026 (LWQ A) — server-stamped lifecycle stage from
  // `recurring_lanes.lifecycle_stage`. UI MUST NOT recompute it.
  lifecycleStage?: string | null;
  // Task #1029 (LWQ D) — owner relationship freshness in days. Server
  // attaches alongside the strategic enrichment so the row's "12d" pill
  // surfaces without recomputation.
  daysSinceLastTouchpoint?: number | null;
  // Task #1051 — Unified ReplitDailyUpload enrichment. The engine writes
  // these straight from `freight_daily_upload_fact` (≥6 moved loads in the
  // last 30 days). The row UI surfaces them as a qualification chip so reps
  // see *why* a lane qualified without opening the lane story.
  movesLast30Days?: number | null;
  lastMovedAt?: string | null;
  qualificationReason?: string | null;
  supportingCustomers?: Array<{ name: string; count: number }> | null;
  recentCarriers?: Array<{ name: string; payeeCode: string | null; lastMovedAt: string; count: number }> | null;
}

interface WorkQueue {
  unassigned: LaneItem[];
  noContactable: LaneItem[];
  assignedUntouched: LaneItem[];
  inProgress: LaneItem[];
  scopeLabel?: string;
  customers?: string[];  // distinct customer names from all visible lanes (for filter dropdown)
  // Workflow OS — Task #917. `hiddenStale` is the count of rows the
  // actionable scope dropped (post-owner filter, pre-pickup-scope) so the
  // shared StaleCountChip can offer the "Show all" recovery affordance.
  // `pickupScope` is echoed back from the request so the URL/saved-view
  // round-trip stays a single source of truth.
  hiddenStale?: number;
  pickupScope?: PickupScopeValue;
  meta?: {
    // "cache" = served from lane_summary_cache (fast).
    // "full"  = cold-start fallback to live aggregation (slow). Show banner.
    source: "cache" | "full";
  };
  pagination?: {
    limit: number;
    nextCursors: {
      unassigned: string | null;
      noContactable: string | null;
      assignedUntouched: string | null;
      inProgress: string | null;
    };
    totals: {
      unassigned: number;
      noContactable: number;
      assignedUntouched: number;
      inProgress: number;
      total: number;
    };
  };
}

// Task #1030 — EngineRunMeta interface relocated to admin-lane-engine.tsx
// alongside the Run Engine + engine-debug-panel UI it powers.

interface EngineHealth {
  state: "healthy" | "degraded" | "down";
  message: string;
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
  // Cockpit-team membership (from /api/team-members). Optional because
  // not every user is yet assigned to a team in early-rollout orgs.
  teamId?: string | null;
  teamLabel?: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Task #1085 — canonical recurring-lane rule (mirrors LWQ_MOVES_THRESHOLD on
// the server). Use `movesLast30Days` from the row, NOT the derived
// `avgLoadsPerWeek`, so the chip + count + filter agree with the queue's
// own ≥6/30d eligibility rule (see Task #1051).
const MIN_MOVES_30D = 6;

function laneLabel(item: { origin: string; originState?: string | null; destination: string; destinationState?: string | null }) {
  return formatLaneDisplay(item.origin, item.originState ?? null, item.destination, item.destinationState ?? null);
}

function confidenceColor(c: string) {
  if (c === "high") return "border-emerald-500/40 text-emerald-400";
  if (c === "medium") return "border-amber-500/40 text-amber-400";
  return "border-slate-500/40 text-slate-400";
}

/** Returns the numeric loads/week value (or null). */
function parseLoadsPerWeek(val: string | null | undefined): number | null {
  if (!val) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

/** Color-coded frequency badge for the loads/week metric. */
function FrequencyBadge({ val }: { val: string | null | undefined }) {
  const n = parseLoadsPerWeek(val);
  if (n === null) return null;
  const rangeLabel = formatWeeklyLoadRange(n);
  if (n >= 3) {
    return (
      <Badge
        variant="outline"
        className="text-[10px] py-0 px-1.5 border-emerald-500/50 text-emerald-400 bg-emerald-500/10 gap-0.5"
        data-testid="freq-badge-high"
      >
        <Zap className="w-2.5 h-2.5" />
        {rangeLabel}
      </Badge>
    );
  }
  if (n >= 2) {
    return (
      <Badge
        variant="outline"
        className="text-[10px] py-0 px-1.5 border-amber-500/50 text-amber-400 bg-amber-500/10 gap-0.5"
        data-testid="freq-badge-medium"
      >
        <Zap className="w-2.5 h-2.5" />
        {rangeLabel}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-[10px] py-0 px-1.5 border-slate-500/30 text-muted-foreground"
      data-testid="freq-badge-low"
    >
      {rangeLabel}
    </Badge>
  );
}

function avgLoadsNum(val: string | null | undefined): number {
  return parseLoadsPerWeek(val) ?? 0;
}

/** Coverage status badge — compact inline badge for work queue rows */
function CoverageStatusBadge({
  profile,
  carriers,
  laneId,
}: {
  profile: CoverageProfile;
  carriers?: CoverageProfileCarrier[];
  laneId: string;
}) {
  const effectiveStatus = profile.manualOverrideStatus ?? profile.coverageStatus;
  const share = profile.topCarrierCoverageShare ? parseFloat(profile.topCarrierCoverageShare) : 0;
  const n = profile.qualifiedCarrierCount;
  const total = profile.sampleSize;

  if (effectiveStatus === "stable") {
    const topCount = carriers?.length ?? n;
    const topLoads = carriers ? carriers.reduce((sum, c) => sum + c.successfulLoadCount, 0) : Math.round(share * total);
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="text-[10px] py-0 px-1.5 border-emerald-500/60 text-emerald-400 bg-emerald-500/10 gap-0.5 cursor-help"
              data-testid={`badge-coverage-status-${laneId}`}
            >
              <Shield className="w-2.5 h-2.5" />
              Stable
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="text-xs max-w-[260px] space-y-1 p-3">
            <p className="font-semibold text-emerald-400">Stable Coverage</p>
            <p className="text-muted-foreground">This lane has one or more carriers hauling the majority of recent loads. Capacity risk is low — monitor but no immediate outreach required.</p>
          </TooltipContent>
        </Tooltip>
        {total > 0 && (
          <span
            className="text-[10px] text-emerald-600 dark:text-emerald-500"
            data-testid={`text-coverage-stat-${laneId}`}
          >
            {topCount} proven carrier{topCount !== 1 ? "s" : ""} · {topLoads} of {total} recent loads
          </span>
        )}
      </div>
    );
  }

  if (effectiveStatus === "watch") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="text-[10px] py-0 px-1.5 border-amber-500/50 text-amber-400 bg-amber-500/10 gap-0.5 cursor-help"
            data-testid={`badge-coverage-status-${laneId}`}
          >
            <TrendingUp className="w-2.5 h-2.5" />
            Watch
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="text-xs max-w-[260px] space-y-1 p-3">
          <p className="font-semibold text-amber-400">Watch — Rising Risk</p>
          <p className="text-muted-foreground">Coverage is thin or concentrated in a single carrier. Consider proactive outreach to build a backup bench before this lane becomes critical.</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="text-[10px] py-0 px-1.5 border-slate-500/30 text-slate-400 gap-0.5 cursor-help"
          data-testid={`badge-coverage-status-${laneId}`}
        >
          No History
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="text-xs max-w-[260px] space-y-1 p-3">
        <p className="font-semibold text-slate-300">No Carrier History</p>
        <p className="text-muted-foreground">No recurring carrier was found in TMS data for this lane. Open the lane to see carrier suggestions and start outreach — you don't need to do anything special first.</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Sort items — high-frequency first, then by laneScore descending.
 *
 * Task #651 — when a `votriByLane` snapshot is supplied, lane-signal
 * priority becomes the highest tier so the parent's signal-tiered order
 * (see `sortedUnassigned`) is preserved through `BucketSection`. Without
 * this tier the load-frequency comparator below would silently cancel
 * the signal ordering.
 */
function sortItems(
  items: LaneItem[],
  votriByLane?: Map<string, Pick<LaneSignalResult, "signal" | "isStale">>,
): LaneItem[] {
  const SIGNAL_PRIORITY: Record<string, number> = {
    hot: 3, warm: 2, stable: 1, cool: 1, stale: 0,
  };
  const signalTier = (it: LaneItem): number => {
    if (!votriByLane || !it.origin || !it.destination) return 0;
    const v = votriByLane.get(`${it.origin}|${it.destination}`);
    if (!v) return 0;
    if (v.isStale) return SIGNAL_PRIORITY.stale;
    return v.signal ? (SIGNAL_PRIORITY[v.signal] ?? 0) : 0;
  };
  return [...items].sort((a, b) => {
    const aSig = signalTier(a);
    const bSig = signalTier(b);
    if (bSig !== aSig) return bSig - aSig;
    const aFreq = avgLoadsNum(a.avgLoadsPerWeek);
    const bFreq = avgLoadsNum(b.avgLoadsPerWeek);
    if (bFreq !== aFreq) return bFreq - aFreq;
    return (b.laneScore ?? 0) - (a.laneScore ?? 0);
  });
}

// ── Reply Badge ───────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  available_now: "Available Now",
  available_next_week: "Available Next Week",
  future_interest: "Future Interest",
  not_fit: "Not a Fit",
};

function ReplyBadge({ summary, laneId }: { summary: LaneReplySummary; laneId: string }) {
  if (summary.totalReplied === 0) return null;

  const isHot = summary.hotCount > 0;
  const topLabel = summary.topStatus ? STATUS_LABELS[summary.topStatus] : null;

  if (isHot) {
    // needsAction = hot reply with no open follow-up task yet — pulse green to flag urgency
    // isHot but not needsAction = follow-up task already created — show muted green (activity)
    const badgeClass = summary.needsAction
      ? "text-[10px] py-0 px-1.5 border-green-500/60 text-green-400 bg-green-500/10 gap-0.5 cursor-help"
      : "text-[10px] py-0 px-1.5 border-green-700/40 text-green-600 bg-green-900/10 gap-0.5 cursor-help";

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={badgeClass}
            data-testid={summary.needsAction ? `badge-reply-needs-action-${laneId}` : `badge-reply-hot-${laneId}`}
          >
            <MessageCircle className="w-2.5 h-2.5" />
            {summary.needsAction ? "⚡ " : ""}{summary.hotCount} {summary.hotCount === 1 ? "reply" : "replies"} — {summary.hotCount === 1 && topLabel ? topLabel : `${summary.hotCount} hot`}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="text-xs max-w-[240px] space-y-1 p-3">
          <p className={`font-semibold ${summary.needsAction ? "text-green-400" : "text-green-600"}`}>
            {summary.needsAction ? "Needs Action — Hot Reply" : "Carrier Replies (Task Created)"}
          </p>
          {summary.topCarrierName && (
            <p className="text-muted-foreground">
              Top: <span className="text-foreground">{summary.topCarrierName}</span> — {topLabel}
            </p>
          )}
          <p className="text-muted-foreground">
            {summary.totalReplied} carrier{summary.totalReplied !== 1 ? "s" : ""} responded · {summary.hotCount} available
          </p>
          {summary.needsAction
            ? <p className="text-green-400 text-[10px] font-medium">No follow-up task yet — classify this reply to create one.</p>
            : <p className="text-muted-foreground text-[10px]">A follow-up task has been created for this lane.</p>
          }
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="text-[10px] py-0 px-1.5 border-slate-500/40 text-slate-400 gap-0.5 cursor-help"
          data-testid={`badge-reply-${laneId}`}
        >
          <MessageCircle className="w-2.5 h-2.5" />
          {summary.totalReplied} replied
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="text-xs max-w-[240px] space-y-1 p-3">
        <p className="font-semibold">Carrier Replies</p>
        {summary.topCarrierName && (
          <p className="text-muted-foreground">Latest: <span className="text-foreground">{summary.topCarrierName}</span> — {topLabel}</p>
        )}
        <p className="text-muted-foreground">{summary.totalReplied} carrier{summary.totalReplied !== 1 ? "s" : ""} responded. Open the lane workspace for details.</p>
      </TooltipContent>
    </Tooltip>
  );
}

// ── Assign-to Dropdown ────────────────────────────────────────────────────────

function AssignToDropdown({
  laneId,
  laneOwnerUserId,
  teamMembers,
  onAssigned,
}: {
  laneId: string;
  laneOwnerUserId?: string | null;
  teamMembers: TeamMember[];
  onAssigned: () => void;
}) {
  // Derive the lane's team from its current owner; returns nulls when
  // the owner isn't in the roster yet (predicate then skips team check).
  const findOwnerTeam = (
    userId?: string | null,
  ): { teamId: string | null; teamLabel: string | null } => {
    if (!userId) return { teamId: null, teamLabel: null };
    const owner = teamMembers.find(m => m.id === userId);
    return {
      teamId: owner?.teamId ?? null,
      teamLabel: owner?.teamLabel ?? null,
    };
  };
  const laneTeam = findOwnerTeam(laneOwnerUserId);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  // Inline assignability override state — captured when the rep
  // confirms an ineligible pick; the rationale is sent on the assign
  // request and logged server-side.
  const [pendingOverride, setPendingOverride] = useState<{
    candidate: TeamMember;
    reason: string;
    rationale: string;
  } | null>(null);

  type AssignVariables = {
    ownerUserId: string;
    assignAnyway?: boolean;
    overrideReason?: string;
  };

  const assignMutation = useMutation({
    mutationFn: (vars: AssignVariables) =>
      apiRequest("POST", `/api/recurring-lanes/${laneId}/assign`, vars).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: "Lane assigned" });
      setOpen(false);
      setPendingOverride(null);
      onAssigned();
    },
    onError: (err: unknown) => {
      const msg = (err as { message?: string })?.message ?? "Assignment failed";
      toast({ title: msg, variant: "destructive" });
    },
  });

  // Show every team member so the diagnostic can flag non-outreach roles
  // explicitly rather than silently hiding them. The predicate decides
  // whether each entry is eligible, partial, or override-only.
  const candidates = [...teamMembers].sort((a, b) => a.name.localeCompare(b.name));

  if (candidates.length === 0) return null;

  return (
    <div className="relative" onClick={e => e.stopPropagation()}>
      <Button
        size="sm"
        variant="outline"
        className="h-6 text-[10px] px-2 border-amber-400/30 text-amber-400 hover:bg-amber-500/10 gap-1"
        onClick={() => { setOpen(v => !v); setPendingOverride(null); }}
        disabled={assignMutation.isPending}
        data-testid={`btn-assign-to-${laneId}`}
      >
        {assignMutation.isPending
          ? <Loader2 className="w-3 h-3 animate-spin" />
          : <><User className="w-3 h-3" />Assign to…<ChevronDown className="w-3 h-3" /></>
        }
      </Button>
      {open && (
        <div className="absolute left-0 top-7 z-50 bg-card border border-border rounded-lg shadow-lg min-w-[220px] py-1 max-h-72 overflow-y-auto">
          {candidates.map(m => {
            const verdict = canAssignLane(
              {
                laneId,
                ownerUserId: laneOwnerUserId ?? null,
                teamId: laneTeam.teamId,
                teamLabel: laneTeam.teamLabel,
              },
              {
                id: m.id,
                name: m.name,
                role: m.role,
                teamId: m.teamId ?? null,
                teamLabel: m.teamLabel ?? null,
              },
            );
            const ineligible = !verdict.ok;
            return (
              <button
                key={m.id}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${
                  ineligible
                    ? "hover:bg-amber-500/10 text-muted-foreground"
                    : "hover:bg-muted/60"
                }`}
                onClick={() => {
                  if (verdict.ok) {
                    assignMutation.mutate({ ownerUserId: m.id });
                    return;
                  }
                  // Open the inline confirmation row instead of firing.
                  setPendingOverride({
                    candidate: m,
                    reason: verdict.reason,
                    rationale: "",
                  });
                }}
                data-testid={`assign-option-${laneId}-${m.id}`}
              >
                <User className="w-3 h-3 text-muted-foreground shrink-0" />
                <span className="truncate">{m.name}</span>
                {ineligible && (
                  <span
                    className="text-[10px] text-amber-400 shrink-0 ml-auto"
                    data-testid={`assign-option-flag-${laneId}-${m.id}`}
                  >
                    Override
                  </span>
                )}
                {!ineligible && (
                  <span className="text-[10px] text-muted-foreground/60 shrink-0 ml-auto">
                    {m.role === "account_manager" ? "AM" : m.role === "logistics_manager" ? "LM" : ""}
                  </span>
                )}
              </button>
            );
          })}
          {pendingOverride && (
            <div
              className="border-t border-border px-3 py-2 space-y-2 bg-amber-500/5"
              data-testid={`assign-override-row-${laneId}`}
            >
              <p className="text-[11px] text-amber-400 leading-snug">
                {pendingOverride.reason}
              </p>
              <Input
                value={pendingOverride.rationale}
                onChange={e =>
                  setPendingOverride(p =>
                    p ? { ...p, rationale: e.target.value } : p,
                  )
                }
                placeholder="Why assign anyway? (logged for audit)"
                className="h-7 text-[11px]"
                data-testid={`input-assign-override-reason-${laneId}`}
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="default"
                  className="h-6 text-[10px] px-2"
                  onClick={() =>
                    assignMutation.mutate({
                      ownerUserId: pendingOverride.candidate.id,
                      assignAnyway: true,
                      overrideReason:
                        pendingOverride.rationale.trim() ||
                        pendingOverride.reason,
                    })
                  }
                  disabled={assignMutation.isPending}
                  data-testid={`btn-assign-override-confirm-${laneId}`}
                >
                  Assign anyway
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[10px] px-2"
                  onClick={() => setPendingOverride(null)}
                  data-testid={`btn-assign-override-cancel-${laneId}`}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Lane Row ──────────────────────────────────────────────────────────────────

const MANAGER_ROLES = ["admin", "director", "national_account_manager", "logistics_manager"];

// Task #1029 (LWQ D) — Roles allowed to deep-link from a row's overflow
// menu into /admin/lane-engine for structural Edit/Delete. Mirrors the
// admin-mode gate at the bottom of this file (`LWQ_ADMIN_ROLES`); kept
// duplicated here so LaneRow stays a self-contained presentational
// component without coupling to the page-level mode logic.
const ROW_ADMIN_ROLES = ["admin", "director", "national_account_manager", "sales_director"];

// Task #1029 (LWQ D) — Display labels for `recurring_lanes.lifecycle_stage`
// (Task #1026/A). Stage strings come straight off the row from the server;
// the UI MUST NOT recompute them from raw signals (guardrail enforced).
const LIFECYCLE_LABELS: Record<string, string> = {
  detected: "Detected",
  qualified: "Qualified",
  assigned: "Assigned",
  contactable: "Contactable",
  contacted: "Contacted",
  engaged: "Engaged",
  operationalized: "Operationalized",
};

// Owner-initials avatar — falls back to "?" so unassigned rows still
// render a consistent slot. Kept as a tiny inline component (no shadcn
// Avatar) to avoid the extra DOM weight inside a virtualized list.
function OwnerInitialsAvatar({ name, laneId }: { name?: string | null; laneId: string }) {
  const initials = (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(p => p[0]!.toUpperCase())
    .join("") || "?";
  return (
    <span
      className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[9px] font-semibold border shrink-0 ${
        name ? "bg-blue-500/15 border-blue-500/40 text-blue-300" : "bg-muted/50 border-border text-muted-foreground"
      }`}
      title={name ?? "Unassigned"}
      data-testid={`avatar-owner-${laneId}`}
    >
      {initials}
    </span>
  );
}

// Reason chip — renders Task B's `priorityExplanation.topReason` verbatim.
// Hidden gracefully when the server omits the explanation (e.g. legacy
// callers without strategic enrichment). UI MUST NOT recompute the
// reason — guardrail enforces this in `tests/code-quality-guardrails.test.ts`.
function ReasonChip({ topReason, laneId }: { topReason: string; laneId: string }) {
  return (
    <Badge
      variant="outline"
      className="text-[10px] py-0 px-1.5 border-amber-500/40 text-amber-300 bg-amber-500/10 font-medium gap-0.5"
      title={`Top strategic reason: ${topReason}`}
      data-testid={`chip-reason-${laneId}`}
    >
      {topReason}
    </Badge>
  );
}

// Lifecycle badge — reads `recurring_lanes.lifecycle_stage` straight off
// the row (Task #1026/A). Pure mapping from stage → display label; no
// derivation from raw signals.
function LifecycleBadge({ stage, laneId }: { stage: string; laneId: string }) {
  const label = LIFECYCLE_LABELS[stage] ?? stage;
  return (
    <Badge
      variant="outline"
      className="text-[9px] py-0 px-1 border-slate-500/40 text-slate-300 bg-slate-500/10"
      title={`Lifecycle stage: ${label}`}
      data-testid={`badge-lifecycle-${laneId}`}
    >
      {label}
    </Badge>
  );
}

// Touchpoint-age pill — promotes the `daysSinceLastTouchpoint` field the
// server now stamps on every strategic-enriched row (Task #1029). Color
// scales with staleness so reps spot dormant relationships at a glance:
//   ≤ 7d  → green   (fresh)
//   ≤ 21d → amber   (warming up)
//   > 21d → red     (stale)
function TouchpointAgePill({ days, laneId }: { days: number; laneId: string }) {
  const tone =
    days <= 7 ? "border-emerald-500/40 text-emerald-300 bg-emerald-500/10"
    : days <= 21 ? "border-amber-500/40 text-amber-300 bg-amber-500/10"
    : "border-red-500/40 text-red-300 bg-red-500/10";
  return (
    <span
      className={`inline-flex items-center text-[10px] font-medium px-1.5 py-0 rounded-full border ${tone}`}
      title={`Last owner touchpoint with this customer: ${days} day${days === 1 ? "" : "s"} ago`}
      data-testid={`pill-touchpoint-age-${laneId}`}
    >
      {days}d
    </span>
  );
}

// Backward-compatible alias — see Task #651. Lane signals are now sourced
// from the shared `useLaneSignals` hook, whose richer `LaneSignalResult`
// shape is structurally a superset of the fields LaneRow needs.
type LaneVotriData = Pick<LaneSignalResult, "votri" | "votriWoW" | "signal" | "isStale">;

function LaneRow({
  item,
  completionThreshold,
  onOpen,
  onOpenCockpit,
  bucket,
  teamMembers,
  selected = false,
  onToggleSelect,
  votriData,
}: {
  item: LaneItem;
  completionThreshold: number;
  onOpen: (laneId: string) => void;
  // Task #888 — opens the LaneCockpitSheet pinned to this lane's
  // signature. Mirrors the `L` keyboard shortcut so trackpad users
  // have the same affordance from the row's overflow menu.
  onOpenCockpit?: (item: LaneItem) => void;
  bucket: keyof WorkQueue;
  teamMembers: TeamMember[];
  selected?: boolean;
  onToggleSelect?: (laneId: string) => void;
  votriData?: LaneVotriData;
}) {
  const { toast } = useToast();

  // Prefetch detail data on hover so the panel opens instantly
  function handleMouseEnter() {
    queryClient.prefetchQuery({
      queryKey: ["/api/recurring-lanes", item.laneId, "detail"],
      queryFn: () => fetch(`/api/recurring-lanes/${item.laneId}/detail`).then(r => r.json()),
      staleTime: 2 * 60 * 1000,
    });
  }
  const { user: currentUser } = useAuth();
  const isManager = MANAGER_ROLES.includes(currentUser?.role ?? "");
  // Task #1030 — Edit/Delete row actions (with dialogs, edit-form
  // local state, and the deleteMutation/editMutation hooks they
  // powered) were relocated to /admin/lane-engine so reps can't
  // fat-finger structural lane changes mid-outreach.

  const selfAssignMutation = useMutation({
    mutationFn: (ownerUserId: string | null) =>
      apiRequest("POST", `/api/recurring-lanes/${item.laneId}/assign`, { ownerUserId }).then(r => r.json()),
    onSuccess: (updatedLane, ownerUserId) => {
      // In-place cache patch — avoids a full refetch for simple assign/unassign.
      queryClient.setQueryData<WorkQueue>(["/api/recurring-lanes/work-queue"], (prev) => {
        if (!prev) return prev;
        const patchBucket = (bucket: LaneItem[]): LaneItem[] =>
          bucket.map(i =>
            i.laneId === item.laneId
              ? {
                  ...i,
                  ownerUserId: ownerUserId ?? null,
                  ownerName: ownerUserId
                    ? (updatedLane?.ownerName ?? i.ownerName)
                    : null,
                }
              : i
          );
        return {
          ...prev,
          unassigned: patchBucket(prev.unassigned ?? []),
          noContactable: patchBucket(prev.noContactable ?? []),
          assignedUntouched: patchBucket(prev.assignedUntouched ?? []),
          inProgress: patchBucket(prev.inProgress ?? []),
        };
      });
      // Structural changes (bucket reassignment) still require a background invalidation
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: ownerUserId === null ? "Lane unassigned" : "Lane assigned" });
    },
    onError: () => toast({ title: "Assignment failed", variant: "destructive" }),
  });

  const canUnassign = item.ownerUserId &&
    (isManager || item.ownerUserId === currentUser?.id);

  const { data: coverageData } = useQuery<{ profile: CoverageProfile; carriers: CoverageProfileCarrier[] }>({
    queryKey: ["/api/lanes", item.laneId, "coverage-profile"],
    queryFn: () => fetch(`/api/lanes/${item.laneId}/coverage-profile`).then(r => r.ok ? r.json() : null),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // Reply summary — reads from prefetch cache populated on hover (handleMouseEnter).
  // refetchOnMount/WindowFocus: false prevents N simultaneous requests when the LWQ loads.
  // After the user hovers a card, the prefetch fires and React Query re-renders this observer reactively.
  const { data: laneDetail } = useQuery<{ replySummary: LaneReplySummary }>({
    queryKey: ["/api/recurring-lanes", item.laneId, "detail"],
    queryFn: () => fetch(`/api/recurring-lanes/${item.laneId}/detail`).then(r => r.json()),
    staleTime: 2 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const hasHotReply = (laneDetail?.replySummary?.hotCount ?? 0) > 0;
  const replyNeedsAction = laneDetail?.replySummary?.needsAction ?? false;

  const contacted = item.carriersContactedCount ?? 0;
  const progressPct = Math.min(100, (contacted / completionThreshold) * 100);
  const loadsNum = avgLoadsNum(item.avgLoadsPerWeek);
  const isHighFreq = item.isHighFrequency ?? ((item.movesLast30Days ?? 0) >= MIN_MOVES_30D);

  return (
    <div
      // Focusable so Shift+L moves real DOM focus (not just state).
      tabIndex={0}
      role="button"
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(item.laneId);
        }
      }}
      className={`bg-card border rounded-lg p-4 hover:border-amber-500/30 transition-colors cursor-pointer group focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
        selected
          ? "border-blue-500/60 bg-blue-950/10 ring-1 ring-blue-500/30"
          : hasHotReply
            ? replyNeedsAction
              ? "border-green-500/40 bg-green-950/5"
              : "border-green-700/30 bg-green-950/3"
            : isHighFreq
              ? "border-amber-500/20"
              : "border-border"
      }`}
      onClick={() => onOpen(item.laneId)}
      onMouseEnter={handleMouseEnter}
      data-testid={`work-queue-row-${item.laneId}`}
    >
      <div className="flex items-start gap-3">
        {onToggleSelect && (
          <div
            className="pt-0.5 shrink-0"
            onClick={e => { e.stopPropagation(); onToggleSelect(item.laneId); }}
          >
            <div
              className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                selected
                  ? "bg-blue-500 border-blue-500"
                  : "border-muted-foreground/40 hover:border-blue-400"
              }`}
              data-testid={`checkbox-lane-${item.laneId}`}
            >
              {selected && <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 10 10" fill="none"><path d="M1.5 5l2.5 2.5 4.5-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </div>
          </div>
        )}
        <div className="flex-1 min-w-0">
          {/* Task #1029 (LWQ D) — Strategic tier. Leads with the customer
              name + Task B's reason chip + Task A's lifecycle stage badge,
              and promotes the relationship signals (owner avatar +
              last-touchpoint age) to first-class metadata so reps see
              "why now / who owns / how stale" at a glance, without
              hunting through the row body. Each strategic field renders
              only when the server supplies it (graceful degradation). */}
          {(item.companyName || item.priorityExplanation?.topReason || item.lifecycleStage || item.ownerName || typeof item.daysSinceLastTouchpoint === "number") && (
            <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
              {item.companyName && (
                <>
                  <Building2 className="w-3 h-3 text-blue-400 shrink-0" />
                  <span className="text-xs font-semibold text-blue-500 dark:text-blue-400">{formatCustomerName(item.companyName)}</span>
                  {item.companyId ? (
                    <Badge variant="outline" className="text-[9px] py-0 px-1 border-blue-500/30 text-blue-400 bg-blue-500/10">CRM</Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px] py-0 px-1 border-slate-500/30 text-muted-foreground" title="Customer name from TMS — not yet matched to a CRM account">TMS name</Badge>
                  )}
                </>
              )}
              {item.priorityExplanation?.topReason && (
                <ReasonChip topReason={item.priorityExplanation.topReason} laneId={item.laneId} />
              )}
              {item.lifecycleStage && (
                <LifecycleBadge stage={item.lifecycleStage} laneId={item.laneId} />
              )}
              {/* Owner avatar + touchpoint freshness — pushed to the right
                  edge of the strategic tier so the eye lands on the
                  relationship pair after reading the reason. */}
              <span className="ml-auto inline-flex items-center gap-1.5">
                <OwnerInitialsAvatar name={item.ownerName} laneId={item.laneId} />
                {typeof item.daysSinceLastTouchpoint === "number" && (
                  <TouchpointAgePill days={item.daysSinceLastTouchpoint} laneId={item.laneId} />
                )}
              </span>
            </div>
          )}
          {/* Lane label + badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={laneStoryHref(item.origin, item.originState, item.destination, item.destinationState, item.equipmentType)}>
              <span
                className="text-sm font-semibold text-foreground hover-elevate cursor-pointer rounded px-1 -mx-1"
                title="Open Lane Story"
                data-testid={`link-lane-story-${item.laneId}`}
              >
                {laneLabel(item)}
              </span>
            </Link>
            {/* Task #635 — Live AF opportunities chip; deep-links into the
                Available Freight cockpit filtered to this lane signature. */}
            {item.liveOpps && item.liveOpps.count > 0 && (
              <LiveOppsChip
                data={item.liveOpps}
                testId={`chip-live-opps-${item.laneId}`}
              />
            )}
            {/* Task #1069 — Hero loop "Active won load(s)" chip. Surfaces
                the subset of live AF opps that originated from a won
                customer quote so the LM can see inbound-email-driven
                loads on the same row as the lane they belong to.
                Hero-loop polish: when we have a laneSignature, deep-link
                the chip into Available Freight filtered to this lane —
                same pattern the live-opps chip uses — so the LM goes from
                "I see the count" to "I see the rows" in one click. */}
            {item.liveOpps && item.liveOpps.wonQuoteCount > 0 && (() => {
              const laneSig = item.liveOpps?.laneSignature ?? null;
              const wonChip = (
                <Badge
                  variant="outline"
                  className={`text-[10px] py-0 px-1.5 border-emerald-500/50 text-emerald-400 bg-emerald-500/10 gap-0.5 font-semibold${laneSig ? " hover:bg-emerald-500/20 hover:border-emerald-500 cursor-pointer transition-colors" : ""}`}
                  data-testid={`chip-active-won-${item.laneId}`}
                  title={`${item.liveOpps!.wonQuoteCount} active won load${item.liveOpps!.wonQuoteCount > 1 ? "s" : ""} sourced from a customer-quote win — ${laneSig ? "click to open in Available Freight" : "open in Available Freight"}`}
                >
                  {item.liveOpps!.wonQuoteCount} active won
                </Badge>
              );
              return laneSig ? (
                <Link
                  href={`/available-freight?lane=${encodeURIComponent(laneSig)}`}
                  onClick={e => e.stopPropagation()}
                  data-testid={`link-active-won-${item.laneId}`}
                >
                  {wonChip}
                </Link>
              ) : wonChip;
            })()}
            {/* Frequency badge — prominent, always first */}
            <FrequencyBadge val={item.avgLoadsPerWeek} />
            {/* High-frequency lane badge (Task #188): shown when ≥2 loads/week */}
            {isHighFreq && (
              <Badge
                variant="outline"
                className="text-[10px] py-0 px-1.5 border-orange-500/50 text-orange-400 bg-orange-500/10 gap-0.5 font-semibold"
                data-testid={`badge-hf-lane-${item.laneId}`}
                title="High-frequency lane: 2+ loads/week — enhanced carrier ranking and bulk outreach enabled"
              >
                <Zap className="w-2.5 h-2.5" />
                HF Lane
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px] py-0 px-1.5">
              {item.equipmentType ?? "Any"}
            </Badge>
            {item.isManual && (
              <Badge
                variant="outline"
                className="text-[10px] py-0 px-1.5 border-blue-500/50 text-blue-400 bg-blue-500/10 gap-0.5 font-semibold"
                data-testid={`badge-manual-lane-${item.laneId}`}
              >
                <PlusCircle className="w-2.5 h-2.5" />
                Manual
              </Badge>
            )}
          </div>

          {/* Coverage status + reply badges + VOTRI signal */}
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            {coverageData?.profile && (
              <CoverageStatusBadge
                profile={coverageData.profile}
                carriers={coverageData.carriers}
                laneId={item.laneId}
              />
            )}
            {laneDetail?.replySummary && laneDetail.replySummary.totalReplied > 0 && (
              <ReplyBadge summary={laneDetail.replySummary} laneId={item.laneId} />
            )}
            {votriData && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={`inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0 rounded-full border cursor-help ${
                      votriData.isStale && votriData.signal === null
                        ? "border-gray-400/50 text-gray-400 bg-gray-500/10"
                        : votriData.signal === "hot" ? "border-red-500/60 text-red-400 bg-red-500/10"
                        : votriData.signal === "warm" ? "border-amber-500/50 text-amber-400 bg-amber-500/10"
                        : votriData.signal === "stable" ? "border-blue-500/50 text-blue-400 bg-blue-500/10"
                        : votriData.signal === "cool" ? "border-green-500/50 text-green-400 bg-green-500/10"
                        : "border-gray-400/50 text-gray-400 bg-gray-500/10"
                    }`}
                    data-testid={`badge-signal-${item.laneId}`}
                  >
                    {votriData.signal === "hot" ? "Tightening"
                      : votriData.signal === "warm" ? "Mild tightening"
                      : votriData.signal === "stable" ? "Stable"
                      : votriData.signal === "cool" ? "Softening"
                      : "No signal"}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="text-xs p-2 max-w-[240px]">
                  <p className="font-semibold">{item.origin} → {item.destination}</p>
                  {votriData.signal !== null
                    ? <>
                        <p>TRAC Direction: {votriData.signal === "hot" ? "Tightening" : votriData.signal === "warm" ? "Mild tightening" : votriData.signal === "stable" ? "Stable" : "Softening"}</p>
                        {votriData.votri !== null && <p>VOTRI: {votriData.votri.toFixed(1)}%</p>}
                        {votriData.votriWoW !== null && <p>WoW: {votriData.votriWoW > 0 ? "+" : ""}{votriData.votriWoW.toFixed(1)} pp</p>}
                      </>
                    : <p className="text-gray-400">Market signal unavailable for this lane</p>
                  }
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {/* Metrics row */}
          <div className="flex items-center gap-4 mt-2 flex-wrap">
            {/* Task #1051 — Qualification reason chip backed by
                freight_daily_upload_fact (≥6 moved loads in last 30 days). */}
            {item.qualificationReason && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="text-[10px] gap-1 border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400 cursor-help"
                    data-testid={`chip-qualification-${item.laneId}`}
                  >
                    {item.movesLast30Days ?? 0}× / 30d
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="text-xs max-w-[280px] p-3 space-y-1.5">
                  <p className="font-semibold">Why this lane qualifies</p>
                  <p className="text-muted-foreground">{item.qualificationReason}</p>
                  {item.lastMovedAt && (
                    <p className="text-muted-foreground">Last moved: <span className="text-foreground">{item.lastMovedAt}</span></p>
                  )}
                  {item.supportingCustomers && item.supportingCustomers.length > 0 && (
                    <div>
                      <p className="font-medium text-foreground">Supporting customers</p>
                      <ul className="text-muted-foreground space-y-0.5">
                        {item.supportingCustomers.slice(0, 3).map(c => (
                          <li key={c.name}>• {c.name} ({c.count})</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {item.recentCarriers && item.recentCarriers.length > 0 && (
                    <div>
                      <p className="font-medium text-foreground">Recent carriers</p>
                      <ul className="text-muted-foreground space-y-0.5">
                        {item.recentCarriers.slice(0, 3).map(c => (
                          <li key={`${c.payeeCode ?? ""}-${c.name}`}>• {c.name} ({c.count})</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-[11px] text-muted-foreground cursor-help">
                  Score: <span className="text-foreground font-medium">{item.laneScore ?? "—"}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent className="text-xs max-w-[240px] space-y-1 p-3">
                <p className="font-semibold">Lane Score</p>
                <p className="text-muted-foreground">Composite priority score based on weekly load frequency and revenue potential. Higher-scored lanes are sorted to the top of each bucket so you work the most impactful lanes first.</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-[11px] text-muted-foreground cursor-help">
                  Bench: <span className="text-foreground font-medium">{item.totalBenchCount}</span>
                  {item.historicalCount > 0 && (
                    <span className="text-blue-500 ml-1">({item.historicalCount} historical)</span>
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent className="text-xs max-w-[260px] space-y-1 p-3">
                <p className="font-semibold">The Bench</p>
                <p className="text-muted-foreground">Carriers who have received outreach for this lane and are being tracked. The goal is 3+ committed carriers per lane.</p>
                <ul className="space-y-0.5 text-muted-foreground">
                  <li>• Active bench — carriers contacted in this outreach cycle.</li>
                  <li>• Historical — carriers who responded positively in a prior cycle and are pre-qualified candidates.</li>
                </ul>
              </TooltipContent>
            </Tooltip>
            {item.contactableCount > 0 ? (
              <span className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-0.5">
                <Phone className="w-3 h-3" />
                {item.contactableCount} contactable
              </span>
            ) : item.totalBenchCount === 0 ? (
              <span className="text-[11px] text-muted-foreground italic flex items-center gap-0.5">
                No carriers on bench
              </span>
            ) : (
              <span className="text-[11px] text-orange-500 flex items-center gap-0.5">
                <Mail className="w-3 h-3" />
                No contact info
              </span>
            )}
            {item.missingContactCount > 0 && (
              <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                {item.missingContactCount} missing email/phone
              </span>
            )}
          </div>

          {/* Progress bar (only for assigned lanes) */}
          {(bucket === "assignedUntouched" || bucket === "inProgress") && (
            <div className="mt-2">
              <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] text-muted-foreground">Carriers Contacted</span>
                <span className="text-[10px] text-muted-foreground">{contacted}/{completionThreshold}</span>
              </div>
              <div className="h-1.5 rounded-full bg-muted">
                <div
                  className={`h-1.5 rounded-full transition-all ${contacted > 0 ? "bg-amber-400" : "bg-muted-foreground/30"}`}
                  style={{ width: `${progressPct}%` }}
                  data-testid={`progress-bar-${item.laneId}`}
                />
              </div>
            </div>
          )}

          {/* Owner chip + assign controls */}
          <div className="flex items-center gap-2 mt-2 flex-wrap" onClick={e => e.stopPropagation()}>
            {item.ownerName ? (
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground bg-muted/50 border border-border rounded-full px-2 py-0.5">
                <User className="w-3 h-3 text-blue-500" />
                {item.ownerName}
              </div>
            ) : (
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <UserX className="w-3 h-3 text-orange-400" />
                <span className="text-orange-400">Unassigned</span>
              </div>
            )}

            {/* Unassign button — shown when lane is assigned and user is owner or manager */}
            {canUnassign && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[10px] px-2 border-red-400/30 text-red-400 hover:bg-red-500/10 gap-1"
                onClick={e => { e.stopPropagation(); selfAssignMutation.mutate(null); }}
                disabled={selfAssignMutation.isPending}
                data-testid={`btn-unassign-${item.laneId}`}
              >
                {selfAssignMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <><UserX className="w-3 h-3" />Unassign</>}
              </Button>
            )}

            {/* Unassigned lane: show both "Assign to me" (for self) and "Assign to..." dropdown (for managers) */}
            {!item.ownerUserId && currentUser && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] px-2 border-blue-400/30 text-blue-400 hover:bg-blue-500/10"
                  onClick={e => { e.stopPropagation(); selfAssignMutation.mutate(currentUser.id); }}
                  disabled={selfAssignMutation.isPending}
                  data-testid={`btn-assign-self-${item.laneId}`}
                >
                  {selfAssignMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Assign to me"}
                </Button>
                {isManager && teamMembers.length > 0 && (
                  <AssignToDropdown
                    laneId={item.laneId}
                    laneOwnerUserId={item.ownerUserId}
                    teamMembers={teamMembers}
                    onAssigned={() => {}}
                  />
                )}
              </>
            )}
          </div>
        </div>

        {/* Right side actions */}
        <div className="flex flex-col items-center gap-2 shrink-0">
          <div className="flex items-center gap-1">
            {/* Task #1030 — Edit/Delete buttons relocated to /admin/lane-engine. */}
            {/* Task #888 — row overflow menu. Currently hosts the
                trackpad-friendly mirror of the `L` keyboard shortcut so
                users who don't reach for the keyboard can still open the
                Lane Cockpit overlay pinned to this lane's signature. */}
            {onOpenCockpit && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground"
                    onClick={e => e.stopPropagation()}
                    data-testid={`btn-row-menu-${item.laneId}`}
                    title="More actions"
                  >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onClick={e => e.stopPropagation()}>
                  <DropdownMenuItem
                    onClick={e => { e.stopPropagation(); onOpenCockpit(item); }}
                    data-testid={`menu-open-cockpit-${item.laneId}`}
                  >
                    Open in Cockpit
                  </DropdownMenuItem>
                  {/* Task #1029 (LWQ D) — Edit/Delete demoted to a
                      role-gated overflow item. The structural editor
                      lives at /admin/lane-engine (Task #1030); this
                      menu just deep-links there for admins so reps
                      can't fat-finger lane geometry mid-outreach. */}
                  {ROW_ADMIN_ROLES.includes(currentUser?.role ?? "") && (
                    <>
                      <DropdownMenuItem asChild data-testid={`menu-edit-lane-${item.laneId}`}>
                        <Link href={`/admin/lane-engine?laneId=${item.laneId}`}>Edit lane (admin)</Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild data-testid={`menu-delete-lane-${item.laneId}`}>
                        <Link href={`/admin/lane-engine?laneId=${item.laneId}&action=delete`}>Delete lane (admin)</Link>
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-amber-400 transition-colors" />
        </div>
      </div>

      {/* Task #1030 — Delete confirmation + Edit lane dialogs were
          relocated to /admin/lane-engine. */}
    </div>
  );
}

// True windowing wrapper for LaneRow — mounts on viewport intersection,
// unmounts on leaving. Off-screen rows render as cheap placeholder divs
// sized to the lane's last measured height so layout stays stable.
type LaneRowProps = {
  item: LaneItem;
  completionThreshold: number;
  onOpen: (laneId: string) => void;
  // Task #888 — see LaneRow's prop docs.
  onOpenCockpit?: (item: LaneItem) => void;
  bucket: keyof WorkQueue;
  teamMembers: TeamMember[];
  selected?: boolean;
  onToggleSelect?: (laneId: string) => void;
  votriData?: LaneVotriData;
};

function LazyLaneRow(props: LaneRowProps) {
  const { item } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [placeholderHeight, setPlaceholderHeight] = useState<number>(
    () => getCachedRowHeight(item.laneId),
  );

  // Task #651 — only request the lane signal once this row has scrolled
  // within the IntersectionObserver lookahead margin. The shared hook
  // batches everything queued in the current frame into one fetch and
  // shares the cache with Available Freight + Customer Quotes.
  const sigList = useMemo<string[]>(() => {
    if (!visible || !item.origin || !item.destination) return [];
    return [laneSigKey(item.origin, item.destination)];
  }, [visible, item.origin, item.destination]);
  const { signals: liveSignals } = useLaneSignals(sigList);
  const liveVotri = sigList.length > 0 ? liveSignals.get(sigList[0]) : null;
  const votriData: LaneVotriData | undefined = props.votriData
    ?? (liveVotri
      ? {
          votri: liveVotri.votri,
          votriWoW: liveVotri.votriWoW,
          signal: liveVotri.signal,
          isStale: liveVotri.isStale,
        }
      : undefined);

  // Single observer toggles `visible` based on intersection — gives us
  // proper mount/unmount cycling with a generous rootMargin so users
  // never see a blank placeholder during fast scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          setVisible(entry.isIntersecting);
        }
      },
      { rootMargin: `${LWQ_VIEWPORT_MARGIN_PX}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // While mounted, record the actual rendered height so when this row
  // unmounts (or future placeholders for the same lane appear) the
  // placeholder occupies exactly the right space. Guarded equality check
  // avoids a ResizeObserver feedback loop.
  useEffect(() => {
    if (!visible) return;
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const h = entry.contentRect.height;
        if (h > 0) {
          setCachedRowHeight(item.laneId, h);
          setPlaceholderHeight(prev => (prev !== h ? h : prev));
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible, item.laneId]);

  return (
    <div
      ref={containerRef}
      style={visible ? undefined : { minHeight: placeholderHeight }}
      data-testid={`lwq-lazy-row-${item.laneId}`}
      data-state={visible ? "mounted" : "placeholder"}
      data-context-anchor-id={item.laneId}
    >
      {visible && <LaneRow {...props} votriData={votriData} />}
    </div>
  );
}

// ── Customer Group ─────────────────────────────────────────────────────────────

function CustomerGroup({
  customerName,
  items,
  completionThreshold,
  onOpen,
  onOpenCockpit,
  bucket,
  teamMembers,
  defaultExpanded,
  selectedLaneIds,
  onToggleSelect,
  votriByLane,
}: {
  customerName: string;
  items: LaneItem[];
  completionThreshold: number;
  onOpen: (laneId: string) => void;
  onOpenCockpit?: (item: LaneItem) => void;
  bucket: keyof WorkQueue;
  teamMembers: TeamMember[];
  defaultExpanded: boolean;
  selectedLaneIds?: Set<string>;
  onToggleSelect?: (laneId: string) => void;
  votriByLane?: Map<string, LaneVotriData>;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Sync when parent triggers "expand all" / "collapse all"
  useEffect(() => {
    setExpanded(defaultExpanded);
  }, [defaultExpanded]);

  const totalLoads = items.reduce((sum, i) => sum + avgLoadsNum(i.avgLoadsPerWeek), 0);
  const recurring30dCount = items.filter(i => (i.movesLast30Days ?? 0) >= MIN_MOVES_30D).length;
  const hasCrmMatch = items.some(i => i.companyId);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden" data-testid={`customer-group-${customerName}`}>
      {/* Customer header row */}
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(v => !v)}
        data-testid={`customer-group-toggle-${customerName}`}
      >
        <ChevronRight className={`w-4 h-4 text-muted-foreground/60 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
        <Building2 className="w-3.5 h-3.5 text-blue-400 shrink-0" />
        <span className="text-sm font-semibold text-foreground flex-1 min-w-0 truncate">
          {formatCustomerName(customerName)}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {hasCrmMatch && (
            <Badge variant="outline" className="text-[9px] py-0 px-1 border-blue-500/30 text-blue-400 bg-blue-500/10">CRM</Badge>
          )}
          {recurring30dCount > 0 && (
            <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-amber-500/50 text-amber-400 bg-amber-500/10 gap-0.5">
              <Zap className="w-2.5 h-2.5" />
              {recurring30dCount} 6× / 30d
            </Badge>
          )}
          <span className="text-[11px] text-muted-foreground">
            {totalLoads.toFixed(1)} loads/wk avg
          </span>
          <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
            {items.length} lane{items.length !== 1 ? "s" : ""}
          </Badge>
          {items[0]?.laneId && (
            <ContextNotePopover
              anchor={{ type: "lane_work_queue", id: items[0].laneId }}
              title="Lane notes"
            />
          )}
        </div>
      </button>

      {/* Lane rows — shown only when expanded.
          Each row is wrapped in `LazyLaneRow` so off-screen LaneRow
          instances stay as cheap placeholders until the user scrolls
          near them (Task #648). */}
      {expanded && (
        <div className="flex flex-col gap-1 px-2 pb-2 pt-0 border-t border-border/50 bg-muted/10">
          {items.map(item => (
            <LazyLaneRow
              key={item.laneId}
              item={item}
              completionThreshold={completionThreshold}
              onOpen={onOpen}
              onOpenCockpit={onOpenCockpit}
              bucket={bucket}
              teamMembers={teamMembers}
              selected={selectedLaneIds?.has(item.laneId) ?? false}
              onToggleSelect={onToggleSelect}
              votriData={item.origin && item.destination
                ? votriByLane?.get(`${item.origin}|${item.destination}`)
                : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Bucket Section ─────────────────────────────────────────────────────────────

function BucketSection({
  title,
  description,
  icon: Icon,
  iconColor,
  items,
  completionThreshold,
  onOpen,
  onOpenCockpit,
  bucket,
  teamMembers,
  recurring30dOnly,
  selectedLaneIds,
  onToggleSelect,
  votriByLane,
  preserveServerOrder = false,
  flatList = false,
}: {
  title: string;
  description: string;
  icon: React.FC<{ className?: string }>;
  iconColor: string;
  items: LaneItem[];
  completionThreshold: number;
  onOpen: (laneId: string) => void;
  onOpenCockpit?: (item: LaneItem) => void;
  bucket: keyof WorkQueue;
  teamMembers: TeamMember[];
  recurring30dOnly: boolean;
  selectedLaneIds?: Set<string>;
  onToggleSelect?: (laneId: string) => void;
  votriByLane?: Map<string, LaneVotriData>;
  // Task #1028 (LWQ C) — when true, the parent has asked the server to
  // rank these rows (Strategic mode → strategicPriority desc; Outreach
  // mode → hotReplyCount desc). Skip the local signal-tier resort so we
  // don't silently override server ranking. When false the legacy
  // signal/frequency/laneScore fallback applies (used in Triage/Admin).
  preserveServerOrder?: boolean;
  // Task #1028 (LWQ C) — when true, render rows as a single flat list
  // (no customer grouping). Used by Outreach mode where the unit of
  // work is "the next reply to act on", not "this customer's lanes".
  flatList?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [allCustomersExpanded, setAllCustomersExpanded] = useState(false);

  const visibleItems = useMemo(() => {
    // Task #651 — pass the shared lane-signal snapshot so signal priority
    // is the highest sort tier and the parent's signal-tiered ordering
    // (see `sortedUnassigned`) survives this re-sort.
    // Task #1028 (LWQ C) — when the server-side ranking is authoritative
    // (Strategic / Outreach modes), keep the items in the order the
    // server returned them and only apply the recurring-30d filter.
    const ordered = preserveServerOrder ? items : sortItems(items, votriByLane);
    return recurring30dOnly ? ordered.filter(i => (i.movesLast30Days ?? 0) >= MIN_MOVES_30D) : ordered;
  }, [items, recurring30dOnly, votriByLane, preserveServerOrder]);

  const hiddenCount = items.length - visibleItems.length;

  // Group items by customer — sort customers by total loads/week desc
  const customerGroups = useMemo(() => {
    const groupMap = new Map<string, LaneItem[]>();
    for (const item of visibleItems) {
      const key = item.companyName?.trim() || "Unknown Customer";
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(item);
    }
    // Sort customers by total loads/week desc
    return [...groupMap.entries()]
      .map(([name, lanes]) => ({
        name,
        lanes,
        totalLoads: lanes.reduce((s, i) => s + avgLoadsNum(i.avgLoadsPerWeek), 0),
      }))
      .sort((a, b) => b.totalLoads - a.totalLoads);
  }, [visibleItems]);

  const customerCount = customerGroups.length;

  return (
    <section className="mb-6" data-testid={`bucket-${bucket}`}>
      {/* Bucket header */}
      <div className="flex items-center gap-3 mb-3">
        <button
          className="flex items-center gap-3 flex-1 text-left"
          onClick={() => setCollapsed(v => !v)}
        >
          <div className={`w-7 h-7 rounded-md flex items-center justify-center ${iconColor}`}>
            <Icon className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground">{title}</h2>
              <Badge variant="secondary" className="text-[10px] h-5 px-1.5">{customerCount} customers</Badge>
              <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-muted-foreground">{visibleItems.length} lanes</Badge>
              {recurring30dOnly && hiddenCount > 0 && (
                <span className="text-[10px] text-muted-foreground/50">(+{hiddenCount} below 6× / 30d hidden)</span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">{description}</p>
          </div>
          <ChevronRight className={`w-4 h-4 text-muted-foreground/50 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`} />
        </button>

        {/* Expand/collapse all customers toggle */}
        {!collapsed && customerCount > 1 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px] px-2 text-muted-foreground hover:text-foreground shrink-0"
            onClick={() => setAllCustomersExpanded(v => !v)}
            data-testid={`btn-toggle-all-customers-${bucket}`}
          >
            {allCustomersExpanded ? "Collapse all" : "Expand all"}
          </Button>
        )}
      </div>

      {!collapsed && (
        <div className="flex flex-col gap-2">
          {visibleItems.length === 0 ? (
            <p className="text-xs text-muted-foreground italic py-2 pl-10">
              {recurring30dOnly && items.length > 0
                ? "No 6× / 30d lanes in this bucket."
                : "No lanes in this bucket."}
            </p>
          ) : flatList ? (
            // Task #1028 (LWQ C) — Outreach mode flat renderer. The unit
            // of work is "the next reply to act on", so we render rows
            // directly in the server's reply-urgency order without the
            // customer-group accordion.
            <div
              className="flex flex-col gap-1 rounded-lg border border-border bg-card px-2 py-2"
              data-testid={`flat-list-${bucket}`}
            >
              {visibleItems.map(item => (
                <LazyLaneRow
                  key={item.laneId}
                  item={item}
                  completionThreshold={completionThreshold}
                  onOpen={onOpen}
                  onOpenCockpit={onOpenCockpit}
                  bucket={bucket}
                  teamMembers={teamMembers}
                  selected={selectedLaneIds?.has(item.laneId) ?? false}
                  onToggleSelect={onToggleSelect}
                  votriData={item.origin && item.destination
                    ? votriByLane?.get(`${item.origin}|${item.destination}`)
                    : undefined}
                />
              ))}
            </div>
          ) : (
            customerGroups.map(group => (
              <CustomerGroup
                key={group.name}
                customerName={group.name}
                items={group.lanes}
                completionThreshold={completionThreshold}
                onOpen={onOpen}
                onOpenCockpit={onOpenCockpit}
                bucket={bucket}
                teamMembers={teamMembers}
                defaultExpanded={allCustomersExpanded}
                selectedLaneIds={selectedLaneIds}
                onToggleSelect={onToggleSelect}
                votriByLane={votriByLane}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

// ── Build Lane Dialog ──────────────────────────────────────────────────────────

interface BuildLaneForm {
  origin: string;
  originState: string;
  destination: string;
  destinationState: string;
  equipmentType: string;
  avgLoadsPerWeek: string;
  companyName: string;
  notes: string;
  dropTrailerShipper: boolean;
  dropTrailerReceiver: boolean;
  ownerUserId: string;
}

const EQUIPMENT_TYPES = ["Box Truck", "Conestoga", "Dry Van", "Flatbed", "Other", "Power Only", "Reefer", "RGN", "Step Deck", "Tanker"];

// Task #653 — payload of seed values handed to the dialog when the rep clicks
// "Make this recurring" on an Available Freight row. `source` records where
// the prefill came from so the dialog can show provenance to the rep.
export interface BuildLanePrefill {
  source: "available_freight";
  companyName: string;
  origin: string;
  originState: string;
  destination: string;
  destinationState: string;
  equipmentType: string;
}

function BuildLaneDialog({ open, onClose, onCreated, currentUser, teamMembers, isAdminOrDirector, prefill }: { open: boolean; onClose: () => void; onCreated: () => void; currentUser: { id: string; name: string } | null; teamMembers: TeamMember[]; isAdminOrDirector: boolean; prefill?: BuildLanePrefill | null }) {
  const { toast } = useToast();
  const [form, setForm] = useState<BuildLaneForm>({
    origin: "",
    originState: "",
    destination: "",
    destinationState: "",
    equipmentType: "",
    avgLoadsPerWeek: "",
    companyName: "",
    notes: "",
    dropTrailerShipper: false,
    dropTrailerReceiver: false,
    ownerUserId: currentUser?.id ?? "",
  });
  // Task #653 — track whether the dialog is currently displaying values that
  // came from the AF deep-link, so we can render the "Prefilled from
  // Available Freight" provenance chip in the header. We keep this as
  // separate state (rather than re-reading `prefill`) so the chip survives
  // user edits and disappears the moment the dialog re-opens "blank".
  const [prefilledFromAf, setPrefilledFromAf] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (prefill) {
      // Task #653 — seed every field the AF row gave us, then explicitly
      // blank the fields the rep is supposed to pick (loads/week, owner,
      // notes). This is the documented contract from the task spec.
      setForm({
        origin: prefill.origin ?? "",
        originState: prefill.originState ?? "",
        destination: prefill.destination ?? "",
        destinationState: prefill.destinationState ?? "",
        equipmentType: prefill.equipmentType ?? "",
        avgLoadsPerWeek: "",
        companyName: prefill.companyName ?? "",
        notes: "",
        dropTrailerShipper: false,
        dropTrailerReceiver: false,
        ownerUserId: "",
      });
      setPrefilledFromAf(true);
    } else if (currentUser?.id) {
      setForm(f => ({ ...f, ownerUserId: currentUser.id }));
      setPrefilledFromAf(false);
    } else {
      setPrefilledFromAf(false);
    }
  }, [open, currentUser?.id, prefill]);

  const [originNorm, setOriginNorm] = useState<FieldNormState>(EMPTY_NORM_STATE);
  const [destNorm, setDestNorm] = useState<FieldNormState>(EMPTY_NORM_STATE);

  function runNormalization(city: string, state: string, setter: (s: FieldNormState) => void) {
    if (!city.trim()) {
      setter(EMPTY_NORM_STATE);
      return;
    }
    const result = resolveLaneLocationWithConfidence(city, state || undefined);
    setter({ result, dismissedSuggestion: false, acceptedCandidate: null });
    return result;
  }

  function handleOriginBlur() {
    const result = runNormalization(form.origin, form.originState, setOriginNorm);
    if (result && (result.status === "exact" || result.status === "corrected") && result.city && result.state) {
      setForm(f => ({ ...f, origin: result.city!, originState: result.state! }));
    }
  }

  function handleDestBlur() {
    const result = runNormalization(form.destination, form.destinationState, setDestNorm);
    if (result && (result.status === "exact" || result.status === "corrected") && result.city && result.state) {
      setForm(f => ({ ...f, destination: result.city!, destinationState: result.state! }));
    }
  }

  function handleOriginStateBlur() {
    if (!form.originState.trim()) return;
    const { abbr, valid } = normalizeStateAbbr(form.originState);
    if (valid && abbr) {
      setForm(f => ({ ...f, originState: abbr }));
      const existingStatus = originNorm.result?.status;
      const needsRevalidation = !existingStatus || existingStatus === "invalid" || existingStatus === "ambiguous" || existingStatus === "suggested";
      if (form.origin.trim() && needsRevalidation) {
        runNormalization(form.origin, abbr, setOriginNorm);
      }
    } else if (!valid) {
      setOriginNorm(prev => ({
        ...prev,
        result: {
          status: "invalid",
          canonical: null,
          city: form.origin,
          state: abbr ?? form.originState.toUpperCase(),
          originalInput: `${form.origin}, ${form.originState}`,
        },
        dismissedSuggestion: false,
        acceptedCandidate: null,
      }));
    }
  }

  function handleDestStateBlur() {
    if (!form.destinationState.trim()) return;
    const { abbr, valid } = normalizeStateAbbr(form.destinationState);
    if (valid && abbr) {
      setForm(f => ({ ...f, destinationState: abbr }));
      const existingStatus = destNorm.result?.status;
      const needsRevalidation = !existingStatus || existingStatus === "invalid" || existingStatus === "ambiguous" || existingStatus === "suggested";
      if (form.destination.trim() && needsRevalidation) {
        runNormalization(form.destination, abbr, setDestNorm);
      }
    } else if (!valid) {
      setDestNorm(prev => ({
        ...prev,
        result: {
          status: "invalid",
          canonical: null,
          city: form.destination,
          state: abbr ?? form.destinationState.toUpperCase(),
          originalInput: `${form.destination}, ${form.destinationState}`,
        },
        dismissedSuggestion: false,
        acceptedCandidate: null,
      }));
    }
  }

  function acceptOriginSuggestion(_canonical: string, city: string, state: string) {
    setForm(f => ({ ...f, origin: city, originState: state }));
    setOriginNorm(EMPTY_NORM_STATE);
  }

  function acceptDestSuggestion(_canonical: string, city: string, state: string) {
    setForm(f => ({ ...f, destination: city, destinationState: state }));
    setDestNorm(EMPTY_NORM_STATE);
  }

  const originHasBlockingError = false;
  const destHasBlockingError = false;
  const originHasWarning = originNorm.result?.status === "invalid";
  const destHasWarning = destNorm.result?.status === "invalid";

  const buildMutation = useMutation({
    mutationFn: () => {
      const originResult = resolveLaneLocationWithConfidence(form.origin, form.originState || undefined);
      const destResult = resolveLaneLocationWithConfidence(form.destination, form.destinationState || undefined);

      const finalOrigin = (originResult.status === "exact" || originResult.status === "corrected") && originResult.city
        ? originResult.city
        : form.origin.trim();
      const finalOriginState = (originResult.status === "exact" || originResult.status === "corrected") && originResult.state
        ? originResult.state
        : form.originState.trim() || undefined;
      const finalDest = (destResult.status === "exact" || destResult.status === "corrected") && destResult.city
        ? destResult.city
        : form.destination.trim();
      const finalDestState = (destResult.status === "exact" || destResult.status === "corrected") && destResult.state
        ? destResult.state
        : form.destinationState.trim() || undefined;

      return apiRequest("POST", "/api/lanes/manual", {
        origin: finalOrigin,
        originState: finalOriginState,
        destination: finalDest,
        destinationState: finalDestState,
        equipmentType: form.equipmentType || undefined,
        avgLoadsPerWeek: form.avgLoadsPerWeek ? parseFloat(form.avgLoadsPerWeek) : undefined,
        companyName: form.companyName.trim() || undefined,
        notes: form.notes.trim() || undefined,
        dropTrailerShipper: form.dropTrailerShipper,
        dropTrailerReceiver: form.dropTrailerReceiver,
        ownerUserId: form.ownerUserId || undefined,
      }).then(r => r.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: "Lane created", description: "Manual lane added to the work queue." });
      onCreated();
      onClose();
      setForm({ origin: "", originState: "", destination: "", destinationState: "", equipmentType: "", avgLoadsPerWeek: "", companyName: "", notes: "", dropTrailerShipper: false, dropTrailerReceiver: false, ownerUserId: currentUser?.id ?? "" });
      setOriginNorm(EMPTY_NORM_STATE);
      setDestNorm(EMPTY_NORM_STATE);
      setPrefilledFromAf(false);
    },
    onError: () => toast({ title: "Failed to create lane", variant: "destructive" }),
  });

  const canSubmit =
    form.origin.trim().length > 0 &&
    form.destination.trim().length > 0 &&
    !originHasBlockingError &&
    !destHasBlockingError;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg" data-testid="dialog-build-lane">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlusCircle className="w-4 h-4 text-amber-400" />
            Build Lane
            {prefilledFromAf && (
              <Badge
                variant="outline"
                className="ml-2 text-[10px] font-normal bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30"
                data-testid="badge-build-lane-prefilled-af"
              >
                Prefilled from Available Freight
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* Origin row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="build-origin" className="text-xs">Origin City <span className="text-destructive">*</span></Label>
              <CityAutocompleteInput
                id="build-origin"
                placeholder="e.g. Salt Lake City"
                value={form.origin}
                stateFilter={form.originState}
                onChange={v => {
                  setForm(f => ({ ...f, origin: v }));
                  setOriginNorm(EMPTY_NORM_STATE);
                }}
                onSelect={(city, state) => {
                  setForm(f => ({ ...f, origin: city, originState: state }));
                  setOriginNorm(EMPTY_NORM_STATE);
                }}
                onBlur={handleOriginBlur}
                inputClassName={originHasWarning ? "border-amber-400 focus-visible:ring-amber-400" : ""}
                testId="input-build-origin"
              />
              <LocationFeedback
                norm={originNorm}
                fieldId="origin"
                onAccept={acceptOriginSuggestion}
                onDismiss={() => setOriginNorm(prev => ({ ...prev, dismissedSuggestion: true }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="build-origin-state" className="text-xs">Origin State</Label>
              <Input
                id="build-origin-state"
                placeholder="e.g. UT"
                maxLength={2}
                value={form.originState}
                onChange={e => {
                  setForm(f => ({ ...f, originState: e.target.value.toUpperCase() }));
                }}
                onBlur={handleOriginStateBlur}
                data-testid="input-build-origin-state"
              />
            </div>
          </div>

          {/* Destination row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="build-dest" className="text-xs">Destination City <span className="text-destructive">*</span></Label>
              <CityAutocompleteInput
                id="build-dest"
                placeholder="e.g. Dallas"
                value={form.destination}
                stateFilter={form.destinationState}
                onChange={v => {
                  setForm(f => ({ ...f, destination: v }));
                  setDestNorm(EMPTY_NORM_STATE);
                }}
                onSelect={(city, state) => {
                  setForm(f => ({ ...f, destination: city, destinationState: state }));
                  setDestNorm(EMPTY_NORM_STATE);
                }}
                onBlur={handleDestBlur}
                inputClassName={destHasWarning ? "border-amber-400 focus-visible:ring-amber-400" : ""}
                testId="input-build-dest"
              />
              <LocationFeedback
                norm={destNorm}
                fieldId="dest"
                onAccept={acceptDestSuggestion}
                onDismiss={() => setDestNorm(prev => ({ ...prev, dismissedSuggestion: true }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="build-dest-state" className="text-xs">Destination State</Label>
              <Input
                id="build-dest-state"
                placeholder="e.g. TX"
                maxLength={2}
                value={form.destinationState}
                onChange={e => {
                  setForm(f => ({ ...f, destinationState: e.target.value.toUpperCase() }));
                }}
                onBlur={handleDestStateBlur}
                data-testid="input-build-dest-state"
              />
            </div>
          </div>

          {/* Equipment + Loads/week */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Equipment Type</Label>
              <Select value={form.equipmentType} onValueChange={v => setForm(f => ({ ...f, equipmentType: v === "__none__" ? "" : v }))}>
                <SelectTrigger className="h-9 text-sm" data-testid="select-build-equipment">
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Any</SelectItem>
                  {EQUIPMENT_TYPES.map(t => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="build-loads" className="text-xs">Loads / Week</Label>
              <Input
                id="build-loads"
                type="number"
                min="0.1"
                step="0.5"
                placeholder="e.g. 10"
                value={form.avgLoadsPerWeek}
                onChange={e => setForm(f => ({ ...f, avgLoadsPerWeek: e.target.value }))}
                data-testid="input-build-loads"
              />
            </div>
          </div>

          {/* Drop Trailer Options */}
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={form.dropTrailerShipper}
                onChange={e => setForm(f => ({ ...f, dropTrailerShipper: e.target.checked }))}
                className="rounded border-border"
                data-testid="checkbox-drop-trailer-shipper"
              />
              Drop trailer at shipper
            </label>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={form.dropTrailerReceiver}
                onChange={e => setForm(f => ({ ...f, dropTrailerReceiver: e.target.checked }))}
                className="rounded border-border"
                data-testid="checkbox-drop-trailer-receiver"
              />
              Drop trailer at receiver
            </label>
          </div>

          {/* Customer name */}
          <div className="space-y-1.5">
            <Label htmlFor="build-customer" className="text-xs">Customer Name (optional)</Label>
            <Input
              id="build-customer"
              placeholder="e.g. Acme Corp"
              value={form.companyName}
              onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))}
              data-testid="input-build-customer"
            />
          </div>

          {isAdminOrDirector && teamMembers.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs">Assign to</Label>
              <Select value={form.ownerUserId} onValueChange={v => setForm(f => ({ ...f, ownerUserId: v }))}>
                <SelectTrigger className="h-9 text-sm" data-testid="select-build-assign-to">
                  <SelectValue placeholder="Select team member" />
                </SelectTrigger>
                <SelectContent>
                  {teamMembers.map(m => (
                    <SelectItem key={m.id} value={m.id} data-testid={`option-assign-to-${m.id}`}>
                      {m.name}{m.id === currentUser?.id ? " (me)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Notes */}
          <div className="space-y-1.5">
            <Label htmlFor="build-notes" className="text-xs">Notes / Context (optional)</Label>
            <Textarea
              id="build-notes"
              placeholder="e.g. Customer mentioned 10 loads/wk starting this week, SLC → Dallas corridor"
              rows={3}
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              data-testid="textarea-build-notes"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="btn-build-lane-cancel">Cancel</Button>
          <Button
            onClick={() => buildMutation.mutate()}
            disabled={!canSubmit || buildMutation.isPending}
            className="gap-1.5 bg-amber-500 hover:bg-amber-600 text-white"
            data-testid="btn-build-lane-submit"
          >
            {buildMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlusCircle className="w-3.5 h-3.5" />}
            {buildMutation.isPending ? "Creating…" : "Build Lane"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

// Task #1028 (LWQ C) — Page mode is the primary mental model the user
// picks. Each mode is a thin renderer over the shared row/bucket
// pipeline; nothing about the underlying universe (owner-filter,
// pickup-scope, customer/highFreq/manual) changes between modes.
//   strategic — customer-grouped, ranked by Task B's strategicPriority;
//               default for reps. Foregrounds Untouched + In Progress.
//   outreach  — flat list, sorted by reply urgency (hotReplyCount). Feeds
//               the existing CarrierOutreachPanel on row click.
//   triage    — Unassigned + No Contactable buckets, role-gated.
//   admin     — admin/director/NAM/sales_director only — links to
//               /admin/lane-engine where the engine console lives.
const LWQ_MODES = ["strategic", "outreach", "triage", "admin"] as const;
type LwqMode = typeof LWQ_MODES[number];
function isLwqMode(v: unknown): v is LwqMode {
  return typeof v === "string" && (LWQ_MODES as readonly string[]).includes(v);
}
// Roles allowed into each gated mode. Strategic + Outreach are always
// available so reps never get locked out of the actionable views. The
// admin set MUST stay in lockstep with /admin/lane-engine's ALLOWED_ROLES
// (Task #1030) so a role allowed in here also has the destination page.
const LWQ_TRIAGE_ROLES = ["admin", "director", "national_account_manager", "logistics_manager"] as const;
const LWQ_ADMIN_ROLES = ["admin", "director", "national_account_manager", "sales_director"] as const;
function canAccessLwqMode(role: string | undefined, mode: LwqMode): boolean {
  if (mode === "strategic" || mode === "outreach") return true;
  if (mode === "triage") return (LWQ_TRIAGE_ROLES as readonly string[]).includes(role ?? "");
  if (mode === "admin") return (LWQ_ADMIN_ROLES as readonly string[]).includes(role ?? "");
  return false;
}
// Default mode by role. Reps land on Strategic (the "what should I work
// on next for the business" view); managers also default to Strategic
// so the rep + manager experience matches by default. Either can flip
// via the selector or a deep link.
function defaultLwqModeForRole(_role: string | undefined): LwqMode {
  return "strategic";
}

// Read filter state from URL query string on first render so direct links
// and rep-to-rep handoffs preserve the filter context. Default to today's
// "no filters" behavior on a bare /lane-work-queue load.
//
// Workflow OS — `owner` and `pickupScope` are read via the canonical
// `deserializeFiltersFromUrl` helper (same code path AF + Available Loads
// use). `customer`, `highFreq`, and `manual` stay LWQ-private query keys.
function readUrlFilters(): {
  recurring30dOnly: boolean;
  manualOnly: boolean;
  customerFilter: string;
  owner: OwnerFilterValue;
  pickupScope: PickupScopeValue;
} {
  if (typeof window === "undefined") {
    return {
      recurring30dOnly: false,
      manualOnly: false,
      customerFilter: "__all__",
      owner: "all",
      pickupScope: DEFAULT_PICKUP_SCOPE,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const shared = deserializeFiltersFromUrl(params);
  return {
    // Task #1085 — canonical key is `recurring30d`; read legacy `highFreq=1`
    // for one release so existing bookmarks survive.
    recurring30dOnly: params.get("recurring30d") === "1" || params.get("highFreq") === "1",
    manualOnly: params.get("manual") === "1",
    customerFilter: params.get("customer") || "__all__",
    owner: shared.owner ?? "all",
    pickupScope: shared.pickupScope ?? DEFAULT_PICKUP_SCOPE,
  };
}

export default function LaneWorkQueuePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  // Task #950 — deep-link reveal: when the user lands on /lanes/work-queue
  // with `?contextNote=<id>`, find the lane row that owns the note, scroll
  // it into view and ring it for ~2.5s. Falls back to a toast if the lane
  // isn't currently rendered (e.g. filtered out by highFreq/manual/customer).
  useRevealContextNoteRow({
    surface: "lane_work_queue",
    getRowEl: (anchorId) =>
      document.querySelector<HTMLElement>(`[data-context-anchor-id="${anchorId}"]`),
    fallbackToast: () =>
      toast({
        title: "Linked lane is not in the current view",
        description: "Clear filters or open the note from your Notifications inbox.",
      }),
  });
  const [openLaneId, setOpenLaneId] = useState<string | null>(null);
  // Task #871 — Lane Cockpit overlay state. Opened by `L`, the row
  // overflow chip, or `?` → "Open cockpit". Owns no business state, just
  // the signature + display label so the sheet can render its title
  // without waiting for the round-trip to resolve.
  const [cockpitSignature, setCockpitSignature] = useState<string | null>(null);
  const [cockpitLaneLabel, setCockpitLaneLabel] = useState<string | undefined>(undefined);
  const [cockpitOpen, setCockpitOpen] = useState(false);
  // Task #871 — focused row index drives the shared `j/k/Enter/L` flow.
  // -1 means "nothing focused" (fresh page load) — j or k seed it to 0.
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  // Task #871 — controls the keyboard cheat-sheet dialog.
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const sharedCheatRows = useLaneCheatSheetRows({ surface: "lwq" });
  // Lazy initializers seed from URL once so a refresh / shared link replays
  // the same filtered view the rep was looking at. URL is updated below as
  // filters change so the back-button gives a sensible history of states.
  const [recurring30dOnly, setRecurring30dOnly] = useState(() => readUrlFilters().recurring30dOnly);
  const [manualOnly, setManualOnly] = useState(() => readUrlFilters().manualOnly);
  const [customerFilter, setCustomerFilter] = useState<string>(() => readUrlFilters().customerFilter);
  // Workflow OS — Task #917. Owner + pickup-scope are the two canonical
  // filters threaded through the request and round-tripped via the shared
  // savedViews helpers so a "My lanes today" view authored anywhere in the
  // OS replays correctly here.
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilterValue>(() => readUrlFilters().owner);
  const [pickupScope, setPickupScope] = useState<PickupScopeValue>(() => readUrlFilters().pickupScope);

  // Task #1028 (LWQ C) — Page mode. Read from URL on first paint with a
  // role-fallback to `strategic` (also used when an unauthorized role
  // deep-links into `triage` / `admin`). Round-tripped via the existing
  // URL serialize effect below so the back button + saved-view machinery
  // both see it. Because the auth context can resolve AFTER first paint
  // (hydration race), we capture the URL-requested mode in a ref and
  // promote it once the role becomes known and authorized — otherwise
  // an admin/director who deep-linked into `?mode=admin` would be
  // silently downgraded to Strategic.
  const requestedModeRef = useRef<LwqMode | null>(null);
  const [mode, setMode] = useState<LwqMode>(() => {
    const role = user?.role;
    const def = defaultLwqModeForRole(role);
    if (typeof window === "undefined") return def;
    const v = new URLSearchParams(window.location.search).get("mode");
    if (!isLwqMode(v)) return def;
    requestedModeRef.current = v;
    return canAccessLwqMode(role, v) ? v : def;
  });
  // When auth resolves: (a) downgrade unauthorized active modes to
  // Strategic, and (b) restore a URL-requested mode the first paint
  // had to drop because the role wasn't known yet.
  useEffect(() => {
    const role = user?.role;
    if (!role) return;
    if (!canAccessLwqMode(role, mode)) {
      setMode(defaultLwqModeForRole(role));
      return;
    }
    const requested = requestedModeRef.current;
    if (requested && requested !== mode && canAccessLwqMode(role, requested)) {
      setMode(requested);
      requestedModeRef.current = null;
    }
  }, [user?.role, mode]);

  // Sync filter state → URL (replaceState so we don't spam history with
  // every toggle). Strips empty params so /lane-work-queue stays clean
  // when no filters are active. We start from the canonical
  // `serializeFiltersToUrl` for the OS-shared keys (owner, pickupScope),
  // then layer the LWQ-private keys on top so the round-trip is lossless
  // from a saved view's perspective.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sharedFilters: SharedFilters = {
      owner: ownerFilter,
      pickupScope,
    };
    const params = serializeFiltersToUrl(sharedFilters);
    // Carry forward unrelated query params already on the URL (deep-link
    // markers like `laneId`, `createLane`, `noMatch`, `from`).
    const incoming = new URLSearchParams(window.location.search);
    incoming.forEach((v, k) => {
      if (k === "owner" || k === "pickupScope") return;
      if (k === "highFreq" || k === "recurring30d" || k === "manual" || k === "customer") return;
      if (k === "mode") return;
      if (!params.has(k)) params.set(k, v);
    });
    // Task #1085 — write the canonical key only and strip the legacy one
    // so the URL converges after one round-trip.
    if (recurring30dOnly) params.set("recurring30d", "1"); else params.delete("recurring30d");
    params.delete("highFreq");
    if (manualOnly) params.set("manual", "1"); else params.delete("manual");
    if (customerFilter && customerFilter !== "__all__") params.set("customer", customerFilter);
    else params.delete("customer");
    // Drop the canonical defaults so the URL stays clean on the home view.
    if (ownerFilter === "all") params.delete("owner");
    if (pickupScope === DEFAULT_PICKUP_SCOPE) params.delete("pickupScope");
    // Task #1028 (LWQ C) — `mode` is LWQ-private (not in the cross-surface
    // saved-view contract). Only serialize when set away from the
    // role-default so the URL stays clean for the common case.
    if (mode !== defaultLwqModeForRole(user?.role)) params.set("mode", mode);
    else params.delete("mode");
    const qs = params.toString();
    const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    if (newUrl !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(null, "", newUrl);
    }
  }, [recurring30dOnly, manualOnly, customerFilter, ownerFilter, pickupScope, mode, user?.role]);

  // Active filter count drives whether the "Clear all" affordance shows.
  // Owner + pickupScope only count as "active" when set away from their
  // canonical defaults.
  const activeFilterCount =
    (recurring30dOnly ? 1 : 0) +
    (manualOnly ? 1 : 0) +
    (customerFilter !== "__all__" ? 1 : 0) +
    (ownerFilter !== "all" ? 1 : 0) +
    (pickupScope !== DEFAULT_PICKUP_SCOPE ? 1 : 0);

  const clearAllFilters = () => {
    setRecurring30dOnly(false);
    setManualOnly(false);
    setCustomerFilter("__all__");
    setOwnerFilter("all");
    setPickupScope(DEFAULT_PICKUP_SCOPE);
  };

  // Workflow OS — apply the built-in "My lanes today" view (spec section G).
  const applyMyLanesTodayView = () => {
    const v = myWorkTodayView();
    if (v.owner !== undefined) setOwnerFilter(v.owner);
    if (v.pickupScope !== undefined) setPickupScope(v.pickupScope);
  };

  const [buildLaneOpen, setBuildLaneOpen] = useState(false);
  // Task #653 — prefill payload for the Build Lane dialog when the rep
  // arrives here via "Make this recurring" on an Available Freight row.
  // Null when the dialog should open in its blank/default state.
  const [buildLanePrefill, setBuildLanePrefill] = useState<BuildLanePrefill | null>(null);
  const [, navigate] = useLocation();
  const [sharingOpen, setSharingOpen] = useState(false);

  // Workflow OS — Task #917. Selection is the shared `useRowSelection`
  // hook so the state-transition contract (toggle / setAll / clear /
  // replace) matches AF and Available Loads. Some downstream child
  // components still take a `Set<string>` prop, so we project the array
  // back to a Set for backwards compatibility.
  const selection = useRowSelection();
  const selectedLaneIds = useMemo(() => new Set(selection.selectedIds), [selection.selectedIds]);
  const handleToggleSelect = selection.toggle;
  const [bulkAssignUserId, setBulkAssignUserId] = useState<string>("");
  // Bulk-assign override state captured when the rep picks an
  // ineligible candidate; rationale is sent on the assign request.
  const [bulkAssignOverride, setBulkAssignOverride] = useState<{
    candidateId: string;
    candidateName: string;
    reason: string;
    rationale: string;
  } | null>(null);

  // Bulk assign through runWithUndo: the forward call snapshots prior
  // owners per lane so Undo can restore them individually.
  type BulkAssignResult = {
    ownerUserId: string;
    /** Snapshot of pre-mutation owners so Undo can restore them. */
    prevOwners: Array<{ laneId: string; ownerUserId: string | null }>;
    count: number;
    /** True when the rep used the override path. */
    assignAnyway: boolean;
  };

  const performBulkAssign = async (vars: {
    laneIds: string[];
    ownerUserId: string;
    assignAnyway?: boolean;
    overrideReason?: string;
  }): Promise<BulkAssignResult> => {
    // Snapshot pre-state from the cache so the Undo can target each
    // lane back to its real previous owner instead of nulling the world.
    const cache = queryClient.getQueryData<WorkQueue>([
      "/api/recurring-lanes/work-queue",
      { owner: ownerFilter, pickupScope },
    ]) ?? queryClient.getQueryData<WorkQueue>(["/api/recurring-lanes/work-queue"]);
    const prevOwners: Array<{ laneId: string; ownerUserId: string | null }> = [];
    if (cache) {
      const allLanes = [
        ...(cache.unassigned ?? []),
        ...(cache.noContactable ?? []),
        ...(cache.assignedUntouched ?? []),
        ...(cache.inProgress ?? []),
      ];
      for (const id of vars.laneIds) {
        const lane = allLanes.find(l => l.laneId === id);
        prevOwners.push({ laneId: id, ownerUserId: lane?.ownerUserId ?? null });
      }
    }
    await Promise.all(
      vars.laneIds.map(laneId =>
        apiRequest("POST", `/api/recurring-lanes/${laneId}/assign`, {
          ownerUserId: vars.ownerUserId,
          assignAnyway: vars.assignAnyway,
          overrideReason: vars.overrideReason,
        }).then(r => r.json()),
      ),
    );
    queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
    return {
      ownerUserId: vars.ownerUserId,
      prevOwners,
      count: vars.laneIds.length,
      assignAnyway: !!vars.assignAnyway,
    };
  };

  const invertBulkAssign = async (result: BulkAssignResult): Promise<void> => {
    await Promise.all(
      result.prevOwners.map(({ laneId, ownerUserId }) =>
        apiRequest("POST", `/api/recurring-lanes/${laneId}/assign`, {
          ownerUserId,
          // Always pass override on undo so previous owners outside the
          // outreach role set still restore cleanly.
          assignAnyway: true,
          overrideReason: "undo_bulk_assign",
        }).then(r => r.json()),
      ),
    );
    queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
  };

  // Bulk snooze via runWithUndo. Undo replays an unsnooze against only
  // the ids the server reports succeeded forward.
  type BulkSnoozeResult = {
    succeededIds: string[];
    snoozedUntil: string | null;
    total: number;
    succeeded: number;
    failed: number;
  };
  const performBulkSnooze = async (vars: {
    laneIds: string[];
    snoozedUntil: string | null;
  }): Promise<BulkSnoozeResult> => {
    const r = await apiRequest("POST", "/api/recurring-lanes/bulk-snooze", {
      laneIds: vars.laneIds,
      snoozedUntil: vars.snoozedUntil,
    });
    const j = (await r.json()) as {
      total: number;
      succeeded: number;
      failed: number;
      results: Array<{ id: string; ok: boolean }>;
    };
    queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
    return {
      succeededIds: j.results.filter(x => x.ok).map(x => x.id),
      snoozedUntil: vars.snoozedUntil,
      total: j.total,
      succeeded: j.succeeded,
      failed: j.failed,
    };
  };
  const invertBulkSnooze = async (result: BulkSnoozeResult): Promise<void> => {
    if (!result.succeededIds.length) return;
    await apiRequest("POST", "/api/recurring-lanes/bulk-snooze", {
      laneIds: result.succeededIds,
      snoozedUntil: null,
    });
    queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
  };
  const bulkSnoozeMutation = useMutation({
    mutationFn: (vars: { laneIds: string[]; durationHours: number }) => {
      const until = new Date(Date.now() + vars.durationHours * 60 * 60 * 1000);
      const snoozedUntil = until.toISOString();
      return runWithUndo<typeof vars, BulkSnoozeResult>(
        {
          perform: () => performBulkSnooze({ laneIds: vars.laneIds, snoozedUntil }),
          invert: invertBulkSnooze,
          toastTitle: `Snoozed ${vars.laneIds.length} lane${vars.laneIds.length !== 1 ? "s" : ""}`,
          toastDescription: `Will reappear in ${vars.durationHours}h`,
          toast,
          clearSelection: () => selection.clear(),
          captureSelection: () => selection.selectedIds.slice(),
          restoreSelection: (ids) => selection.replace(ids),
          undoSuccessTitle: "Snooze undone",
          undoFailureTitle: "Couldn't undo snooze",
        },
        vars,
      );
    },
    onError: () => {
      toast({ title: "Failed to snooze lanes", variant: "destructive" });
    },
  });

  const bulkAssignMutation = useMutation({
    mutationFn: (vars: {
      laneIds: string[];
      ownerUserId: string;
      assignAnyway?: boolean;
      overrideReason?: string;
    }) =>
      runWithUndo<typeof vars, BulkAssignResult>(
        {
          perform: performBulkAssign,
          invert: invertBulkAssign,
          toastTitle: `${vars.laneIds.length} lane${vars.laneIds.length !== 1 ? "s" : ""} assigned`,
          toastDescription:
            (teamMembers.find(m => m.id === vars.ownerUserId)?.name
              ? `Assigned to ${teamMembers.find(m => m.id === vars.ownerUserId)!.name}`
              : undefined) +
            (vars.assignAnyway ? " (override)" : ""),
          toast,
          clearSelection: () => {
            selection.clear();
            setBulkAssignUserId("");
            setBulkAssignOverride(null);
          },
          // Restore the prior selection on Undo so the rep can immediately
          // re-pick a different action.
          captureSelection: () => selection.selectedIds.slice(),
          restoreSelection: (ids) => selection.replace(ids),
          undoSuccessTitle: "Reassignment undone",
          undoFailureTitle: "Couldn't undo reassignment",
        },
        vars,
      ),
    onError: () => {
      toast({ title: "Failed to assign lanes", variant: "destructive" });
    },
  });

  // Auto-open a specific lane when ?laneId=... is in the URL (cross-link from Carrier Hub / My Procurement)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const lid = params.get("laneId");
    if (lid) setOpenLaneId(lid);
  }, []);

  // Task #653 — when arriving from Available Freight via "Make this
  // recurring", the AF row deep-links here with `?createLane=1&customer=
  // …&originCity=…&originState=…&destCity=…&destState=…&equipment=…`.
  // Parse those once on mount, set the prefill payload, and open the
  // Build Lane dialog. Falls back gracefully when only some params are
  // present.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("createLane") !== "1") return;
    setBuildLanePrefill({
      source: "available_freight",
      companyName: params.get("customer") ?? "",
      origin: params.get("originCity") ?? "",
      originState: params.get("originState") ?? "",
      destination: params.get("destCity") ?? "",
      destinationState: params.get("destState") ?? "",
      equipmentType: params.get("equipment") ?? "",
    });
    setBuildLaneOpen(true);
  }, []);

  // Task #653 — strip the prefill query params from the URL so a refresh
  // doesn't re-open the dialog and so the URL doesn't carry stale
  // single-use state. Called from both the cancel and create-success paths.
  function clearBuildLanePrefillFromUrl() {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    let dirty = false;
    for (const k of ["createLane", "customer", "originCity", "originState", "destCity", "destState", "equipment"]) {
      if (url.searchParams.has(k)) {
        url.searchParams.delete(k);
        dirty = true;
      }
    }
    if (!dirty) return;
    const qs = url.searchParams.toString();
    navigate(`/lanes/work-queue${qs ? "?" + qs : ""}`, { replace: true });
  }

  // Show a one-time hint when arriving from My Procurement with no lane match.
  // ?noMatch=Ogden%2C%20UT%20%E2%86%92%20Westfield%2C%20MA
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hint = params.get("noMatch");
    if (!hint) return;
    // Defer one tick so the LWQ list has rendered before the toast appears
    const timer = setTimeout(() => {
      toast({
        title: "No lane match found",
        description: `No work queue lane matched "${decodeURIComponent(hint)}" — use the lane list below to locate or create this lane.`,
        duration: 8000,
      });
    }, 300);
    return () => clearTimeout(timer);
  }, []);

  // Task #1030 — runEngineMutation moved to /admin/lane-engine. Reps see
  // the consolidated `status-engine-health` dot in the header instead.

  // Workflow OS — Task #917. Thread owner + pickupScope into the queryKey
  // so the cache splits per-filter, and append them as querystring params
  // so the server-side `applyOwnerFilter` + `applyPickupScope` see the same
  // values the URL serializer round-trips.
  // Task #1027 (LWQ B) — opt-in Strategic sort. The URL is the source of
  // truth so a deep-link / saved view round-trips. Default ("default")
  // preserves the legacy signal-tiered order; "strategic" asks the server
  // to attach the composite + sort by it. The sort key is threaded into
  // the queryKey so each mode keeps its own cache entry.
  type LwqSortMode = "default" | "strategic";
  const initialSortMode: LwqSortMode = (() => {
    if (typeof window === "undefined") return "default";
    const v = new URLSearchParams(window.location.search).get("sort");
    return v === "strategic" ? "strategic" : "default";
  })();
  const [sortMode, setSortMode] = useState<LwqSortMode>(initialSortMode);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (sortMode === "strategic") url.searchParams.set("sort", "strategic");
    else url.searchParams.delete("sort");
    window.history.replaceState({}, "", url.toString());
  }, [sortMode]);

  // Task #1028 (LWQ C) — Strategic mode forces the strategic sort so the
  // server attaches `strategicPriority` + `priorityExplanation` and
  // ranks each bucket by composite. Other modes leave the sort dropdown
  // free for the rep to pick (default vs strategic).
  const effectiveSortMode: LwqSortMode = mode === "strategic" ? "strategic" : sortMode;

  const workQueueQueryParams = useMemo(() => {
    const sp = new URLSearchParams();
    if (ownerFilter && ownerFilter !== "all") {
      sp.set(
        "owner",
        typeof ownerFilter === "string" ? ownerFilter : `specific:${ownerFilter.specificUserId}`,
      );
    }
    if (pickupScope && pickupScope !== DEFAULT_PICKUP_SCOPE) {
      sp.set("pickupScope", pickupScope);
    }
    if (effectiveSortMode === "strategic") sp.set("sort", "strategic");
    // Task #1028 (LWQ C) — thread `mode` so the server can attach the
    // mode-specific enrichment (Outreach → hotReplyCount + reply-urgency
    // sort; other modes are no-ops on the server today).
    sp.set("mode", mode);
    return sp.toString();
  }, [ownerFilter, pickupScope, effectiveSortMode, mode]);
  const { data: queue, isLoading, isError, refetch } = useQuery<WorkQueue>({
    queryKey: ["/api/recurring-lanes/work-queue", { owner: ownerFilter, pickupScope, sort: effectiveSortMode, mode }],
    // SSE-mid-fetch race guard; append ?debug=lwq to log dropped fetches.
    queryFn: () =>
      fetchWithFreshnessGuard<WorkQueue>({
        cacheKey: "/api/recurring-lanes/work-queue",
        debugTag: "lwq",
        fetcher: () =>
          fetch(
            `/api/recurring-lanes/work-queue${workQueueQueryParams ? `?${workQueueQueryParams}` : ""}`,
          ).then(r => r.json()),
      }),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const { data: outreachConfig } = useQuery<{ completionCarriersContacted: number }>({
    queryKey: ["/api/lane-outreach-config"],
    queryFn: () => fetch("/api/lane-outreach-config").then(r => r.json()),
    staleTime: 5 * 60 * 1000,
  });
  const completionThreshold = outreachConfig?.completionCarriersContacted ?? 3;

  const { data: teamMembers = [] } = useQuery<TeamMember[]>({
    queryKey: ["/api/team-members"],
    queryFn: () => fetch("/api/team-members").then(r => r.json()),
  });

  const isAdminOrDirector = ["admin", "director"].includes(user?.role ?? "");
  const isManagerScope = MANAGER_ROLES.includes(user?.role ?? "");

  // Task #1030 — Single cheap aggregate signal that powers the header
  // status dot. The richer engineStatus + sourcingPerf queries (and the
  // freshness signal popover) all moved to /admin/lane-engine.
  const { data: engineHealth } = useQuery<EngineHealth>({
    queryKey: ["/api/lane-engine/health"],
    queryFn: () => fetch("/api/lane-engine/health").then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Task #651 — lane signals are now fetched lazily by each `LazyLaneRow`
  // through the shared `useLaneSignals` hook (per-lane react-query cache,
  // 4-hour staleTime, batched coalescer). The page no longer pre-fetches
  // every bucket up front; only the rows currently inside (or within the
  // IntersectionObserver lookahead margin of) the viewport request data.
  // `votriByLane` is now a read-only snapshot of the shared cache used for
  // sort-by-signal — it auto-updates as new signals fill in.
  const votriByLane = useCachedLaneSignals();

  // Helper to apply customer + high-freq + manual filters to a bucket
  const filterBucket = (items: LaneItem[]) => {
    let out = items;
    if (customerFilter !== "__all__") {
      out = out.filter(i => i.companyName === customerFilter);
    }
    if (recurring30dOnly) {
      out = out.filter(i => (i.movesLast30Days ?? 0) >= MIN_MOVES_30D);
    }
    if (manualOnly) {
      out = out.filter(i => i.isManual);
    }
    return out;
  };

  // Filtered queue used by BucketSection renders
  const filteredQueue = useMemo(() => {
    if (!queue?.unassigned) return null;
    return {
      unassigned: filterBucket(queue.unassigned),
      noContactable: filterBucket(queue.noContactable ?? []),
      assignedUntouched: filterBucket(queue.assignedUntouched ?? []),
      inProgress: filterBucket(queue.inProgress ?? []),
    };
  }, [queue, customerFilter, recurring30dOnly, manualOnly]);

  // Count high-frequency lanes across all buckets for the filter chip label
  const recurring30dCount = useMemo(() => {
    if (!queue?.unassigned) return 0;
    return (
      queue.unassigned.filter(i => (i.movesLast30Days ?? 0) >= MIN_MOVES_30D).length +
      (queue.noContactable ?? []).filter(i => (i.movesLast30Days ?? 0) >= MIN_MOVES_30D).length +
      (queue.assignedUntouched ?? []).filter(i => (i.movesLast30Days ?? 0) >= MIN_MOVES_30D).length +
      (queue.inProgress ?? []).filter(i => (i.movesLast30Days ?? 0) >= MIN_MOVES_30D).length
    );
  }, [queue]);

  const manualLaneCount = useMemo(() => {
    if (!queue?.unassigned) return 0;
    return (
      queue.unassigned.filter(i => i.isManual).length +
      (queue.noContactable ?? []).filter(i => i.isManual).length +
      (queue.assignedUntouched ?? []).filter(i => i.isManual).length +
      (queue.inProgress ?? []).filter(i => i.isManual).length
    );
  }, [queue]);

  // Task #1028 (LWQ C) — Header eligible-count is mode-scoped so the
  // top-of-page total always reconciles with the buckets currently
  // rendered. Pre-1028 this aggregated all four buckets, which made
  // Strategic mode claim more "lanes needing attention" than it ever
  // surfaced — a contract violation flagged by code review.
  const totalLanes = (() => {
    const u = queue?.unassigned?.length ?? 0;
    const n = queue?.noContactable?.length ?? 0;
    const a = queue?.assignedUntouched?.length ?? 0;
    const p = queue?.inProgress?.length ?? 0;
    if (mode === "outreach" || mode === "strategic") return a + p;
    if (mode === "triage") return u + n;
    return u + n + a + p; // admin
  })();

  // Sort unassigned: hot-market lanes (VOTRI signal = "hot") are elevated to the top,
  // then warm, then cool, then stale/unknown — within each signal tier, sort by avgLoadsPerWeek desc.
  // Task #1027 (LWQ B) — when Strategic mode is active the server has
  // already ordered each bucket by the composite `strategicPriority`. We
  // MUST NOT re-sort here or the client would silently override the
  // server's strategic ranking. Pass the bucket through unchanged in
  // that mode; otherwise apply the legacy signal-tiered fallback.
  const sortedUnassigned = useMemo(() => {
    if (effectiveSortMode === "strategic") return filteredQueue?.unassigned ?? [];
    const SIGNAL_PRIORITY: Record<string, number> = {
      hot: 3, warm: 2, stable: 1, cool: 1, stale: 0,
    };
    const lanePriority = (origin?: string | null, destination?: string | null): number => {
      if (!origin || !destination) return 0;
      const v = votriByLane?.get(`${origin}|${destination}`);
      if (!v) return 0;
      if (v.isStale) return SIGNAL_PRIORITY.stale;
      return v.signal ? (SIGNAL_PRIORITY[v.signal] ?? 0) : 0;
    };
    return [...(filteredQueue?.unassigned ?? [])].sort((a, b) => {
      const aSig = lanePriority(a.origin, a.destination);
      const bSig = lanePriority(b.origin, b.destination);
      if (bSig !== aSig) return bSig - aSig;
      const aVal = parseLoadsPerWeek(a.avgLoadsPerWeek) ?? 0;
      const bVal = parseLoadsPerWeek(b.avgLoadsPerWeek) ?? 0;
      return bVal - aVal;
    });
  }, [filteredQueue?.unassigned, votriByLane, effectiveSortMode]);

  // Task #1030 — freshnessSignal query moved to /admin/lane-engine. The
  // LWQ header dot rolls freshness into the engine-health verdict.

  // Task #1028 (LWQ C) — Outreach mode flat list. Spec ordering is:
  //   1. Hot replies first (any bucket)         → hotReplyCount desc
  //   2. Then awaiting follow-up SLA breaches   → inProgress with no
  //      hot reply (carriers contacted, no answer yet)
  //   3. Then untouched contactable lanes       → assignedUntouched
  //      with no hot reply
  // The server batches in `hotReplyCount` and sorts each bucket by
  // hotReplyCount desc. We do a single merged urgency sort across
  // both assigned buckets so a hot reply on an Untouched lane still
  // beats a non-hot In-Progress lane (which would not be true if we
  // just concatenated the two server buckets).
  const outreachFlatItems = useMemo<LaneItem[]>(() => {
    if (!filteredQueue) return [];
    // Tag each row with its source bucket so we can use it as a
    // tiebreaker when hotReplyCount matches (inProgress = follow-up
    // SLA work, beats Untouched).
    const tagged: Array<{ row: LaneItem; bucketRank: number }> = [
      ...filteredQueue.inProgress.map(row => ({ row, bucketRank: 1 })),
      ...filteredQueue.assignedUntouched.map(row => ({ row, bucketRank: 2 })),
    ];
    tagged.sort((a, b) => {
      const aHot = a.row.hotReplyCount ?? 0;
      const bHot = b.row.hotReplyCount ?? 0;
      if (bHot !== aHot) return bHot - aHot;
      if (a.bucketRank !== b.bucketRank) return a.bucketRank - b.bucketRank;
      return (b.row.laneScore ?? 0) - (a.row.laneScore ?? 0);
    });
    return tagged.map(t => t.row);
  }, [filteredQueue]);

  // Task #871 / Task #1028 (LWQ C) — flat ordering of every lane
  // currently visible across the foregrounded buckets in the active
  // mode. j/k navigates this list and Enter / L acts on the focused
  // entry. The order matches what reps see top-to-bottom on the page
  // so keyboard focus tracks the visual order exactly. Mode-scoping
  // is critical here: pre-1028 this aggregated all four buckets, which
  // meant Triage rows could be focused even while Strategic mode hid
  // them, and the hidden-counts summary disagreed with the visible
  // total.
  const flatLaneOrder = useMemo(() => {
    if (!filteredQueue) return [] as LaneItem[];
    if (mode === "outreach") return outreachFlatItems;
    if (mode === "triage") {
      return [...sortedUnassigned, ...filteredQueue.noContactable];
    }
    if (mode === "strategic") {
      return [...filteredQueue.assignedUntouched, ...filteredQueue.inProgress];
    }
    // admin — every bucket is foregrounded
    return [
      ...sortedUnassigned,
      ...filteredQueue.noContactable,
      ...filteredQueue.assignedUntouched,
      ...filteredQueue.inProgress,
    ];
  }, [filteredQueue, sortedUnassigned, outreachFlatItems, mode]);

  // Task #871 — hidden-counts disclosure. Mirrors the AF disclosure: it
  // explains *why* the visible total dropped (filters: high-frequency,
  // manual-only, customer scope) without burying the rep in extra UI.
  const hiddenCountsSummary = useMemo<HiddenCountsSummary | null>(() => {
    if (!queue) return null;
    // Task #1028 (LWQ C) — baseline for the disclosure is the lanes the
    // *active mode* would surface, not the org-wide total. Otherwise
    // Strategic mode would claim a larger total-in-scope than the rows
    // it ever renders, which violates the "counts reconcile with the
    // visible list" contract that the cross-tab tiles rely on.
    const bucketsForMode = (m: LwqMode): LaneItem[] => {
      switch (m) {
        case "outreach":
          return [...(queue.assignedUntouched ?? []), ...(queue.inProgress ?? [])];
        case "triage":
          return [...(queue.unassigned ?? []), ...(queue.noContactable ?? [])];
        case "strategic":
          return [...(queue.assignedUntouched ?? []), ...(queue.inProgress ?? [])];
        case "admin":
        default:
          return [
            ...(queue.unassigned ?? []),
            ...(queue.noContactable ?? []),
            ...(queue.assignedUntouched ?? []),
            ...(queue.inProgress ?? []),
          ];
      }
    };
    const all = bucketsForMode(mode);
    const totalInScope = all.length;
    const visible = flatLaneOrder.length;
    const hiddenByCustomer = customerFilter !== "__all__"
      ? all.filter(i => i.companyName !== customerFilter).length
      : 0;
    const hiddenByHighFreq = recurring30dOnly
      ? all.filter(i => (i.movesLast30Days ?? 0) < MIN_MOVES_30D).length
      : 0;
    const hiddenByManual = manualOnly
      ? all.filter(i => !i.isManual).length
      : 0;
    return {
      totalInScope,
      visible,
      buckets: [
        { id: "customer-filter", label: `Customer filter (${customerFilter === "__all__" ? "none" : customerFilter})`, count: hiddenByCustomer },
        { id: "recurring-30d-filter", label: "Recurring filter (≥6 / 30d)", count: hiddenByHighFreq },
        { id: "manual-only-filter", label: "Manual-lanes-only filter", count: hiddenByManual },
      ],
    };
  }, [queue, flatLaneOrder, customerFilter, recurring30dOnly, manualOnly, mode]);

  // Task #871 — open the cockpit overlay for a given LaneItem.
  const openCockpitForLane = (it: LaneItem) => {
    const sig = [
      (it.origin ?? "").trim().toLowerCase(),
      (it.originState ?? "").trim().toLowerCase(),
      (it.destination ?? "").trim().toLowerCase(),
      (it.destinationState ?? "").trim().toLowerCase(),
      (it.equipmentType ?? "").trim().toLowerCase(),
    ].join("|");
    setCockpitSignature(sig);
    setCockpitLaneLabel(
      `${it.origin}${it.originState ? `, ${it.originState}` : ""} → ${it.destination}${it.destinationState ? `, ${it.destinationState}` : ""}`,
    );
    setCockpitOpen(true);
  };

  // Shift+L handshake: focus immediately when ready, otherwise queue
  // the intent and drain when the row list first becomes non-empty.
  const pendingFocusRef = useRef(false);
  const focusFirstRow = useCallback(() => {
    if (flatLaneOrder.length === 0) return false;
    setFocusedIndex(0);
    const first = flatLaneOrder[0];
    if (typeof window !== "undefined" && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(
          `[data-testid="work-queue-row-${first.laneId}"]`,
        );
        el?.focus({ preventScroll: false });
      });
    }
    return true;
  }, [flatLaneOrder]);

  useShortcutTarget("lwq:focus-first-row", () => {
    if (focusFirstRow()) return;
    // Rows not loaded yet — defer until the effect below replays.
    pendingFocusRef.current = true;
  });

  useEffect(() => {
    if (flatLaneOrder.length === 0) return;
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    focusFirstRow();
  }, [flatLaneOrder, focusFirstRow]);

  // Task #871 — wire the shared keyboard registry. Pages register only
  // the handlers they own; the registry guarantees no two surfaces
  // collide on the same key (asserted at module-load time).
  useSharedLaneKeyboard({
    enabled: !cockpitOpen && !showShortcutsHelp && !openLaneId && !buildLaneOpen && !sharingOpen,
    handlers: {
      next: () => {
        if (flatLaneOrder.length === 0) return;
        setFocusedIndex(prev => {
          const start = prev < 0 ? -1 : prev;
          return Math.min(flatLaneOrder.length - 1, start + 1);
        });
      },
      prev: () => {
        if (flatLaneOrder.length === 0) return;
        setFocusedIndex(prev => {
          if (prev < 0) return 0;
          return Math.max(0, prev - 1);
        });
      },
      open: () => {
        const it = flatLaneOrder[focusedIndex];
        if (it) setOpenLaneId(it.laneId);
      },
      openCockpit: () => {
        const it = flatLaneOrder[focusedIndex >= 0 ? focusedIndex : 0];
        if (it) openCockpitForLane(it);
      },
      swapSurface: () => {
        const it = flatLaneOrder[focusedIndex];
        // Carry the lane signature back to AF so the matching live row
        // is auto-focused on landing — same contract AF→LWQ uses.
        if (!it) return navigate("/available-freight?from=lane-work-queue");
        const sig = [
          (it.origin ?? "").trim().toLowerCase(),
          (it.originState ?? "").trim().toLowerCase(),
          (it.destination ?? "").trim().toLowerCase(),
          (it.destinationState ?? "").trim().toLowerCase(),
          (it.equipmentType ?? "").trim().toLowerCase(),
        ].join("|");
        navigate(`/available-freight?lane=${encodeURIComponent(sig)}&from=lane-work-queue`);
      },
      openContacts: () => {
        const it = flatLaneOrder[focusedIndex];
        if (it) setOpenLaneId(it.laneId);
      },
      openNote: () => {
        const it = flatLaneOrder[focusedIndex];
        if (it) setOpenLaneId(it.laneId);
      },
      showHelp: () => setShowShortcutsHelp(true),
    },
  });

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 md:px-6 pt-2">
        <CrossTabBreadcrumb current="lane-work-queue" />
      </div>
      {/* Task #926 — Copilot recommendations scoped to the open lane cockpit. */}
      {cockpitSignature && (
        <div className="px-4 md:px-6 pt-2">
          <EmbeddedPlayCard scope={{ laneKey: cockpitSignature }} dataTestIdPrefix="lwq-embedded-plays" />
        </div>
      )}
      {/* Header */}
      <div className="border-b border-border px-4 md:px-6 py-3 md:py-4 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-card">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 md:w-9 md:h-9 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
            <ListFilter className="w-4 h-4 md:w-5 md:h-5 text-amber-500" />
          </div>
          <div>
            <h1 className="text-base md:text-lg font-bold text-foreground flex items-center gap-1.5">
              Lane Work Queue
              <InfoTooltip
                title="Lane Work Queue"
                text="Your prioritized list of recurring freight lanes that need carrier coverage. Lanes are scored and sorted by freight volume and urgency."
                items={[
                  "Unassigned — no rep owns this lane yet. Managers assign lanes to their team.",
                  "No Contactable Carriers — a rep is assigned but the bench has no carriers with email or phone.",
                  "Assigned Untouched — has contactable carriers but no outreach has been sent.",
                  "In Progress — outreach is underway; the goal is 3+ contacted carriers per lane.",
                  "Click any lane to open the Outreach Panel and start contacting carriers.",
                ]}
                side="bottom"
                wide
              />
            </h1>
            <p className="text-xs text-muted-foreground">
              {isLoading ? "Loading…" : `${totalLanes} eligible lane${totalLanes !== 1 ? "s" : ""} needing attention`}
            </p>
            <div className="mt-1">
              {/* Task #1051 — shared "last upload at" pill. */}
              <UnifiedUploadFreshnessPill surface="lwq" />
            </div>
            {/* Scope indicator — shows hierarchy context */}
            {queue?.scopeLabel && (
              <span
                className="inline-flex items-center gap-1 mt-1 text-[11px] text-muted-foreground border border-border rounded-full px-2 py-0.5 bg-muted/40"
                data-testid="scope-label"
              >
                <Eye className="w-3 h-3" />
                Showing: {queue.scopeLabel}
              </span>
            )}
            {/* Task #1030 — cache "warming up" banner moved to
                /admin/lane-engine; reps just see the engine-health dot. */}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Task #1030 — small status dot replaces the FreshnessPill +
              cache banner + run-engine surfaces on the rep page. Clicking
              the dot deep-links into /admin/lane-engine where the full
              operational console lives. Visible to every rep so they know
              when source feeds or the engine are degraded. */}
          {(() => {
            // Use a neutral "unknown" state until /api/lane-engine/health
            // responds so the dot never optimistically claims healthy
            // when the backend is unreachable or still loading.
            const state: "healthy" | "degraded" | "down" | "unknown" =
              engineHealth?.state ?? "unknown";
            const tone =
              state === "healthy" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
              : state === "degraded" ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
              : state === "down" ? "border-red-500/40 bg-red-500/10 text-red-400"
              : "border-border bg-muted/30 text-muted-foreground";
            const dotTone =
              state === "healthy" ? "bg-emerald-500 animate-pulse"
              : state === "degraded" ? "bg-amber-500"
              : state === "down" ? "bg-red-500"
              : "bg-muted-foreground/50 animate-pulse";
            const label = state === "unknown" ? "Engine: checking…" : `Engine: ${state}`;
            return (
              <Link href="/admin/lane-engine">
                <a
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-[11px] font-medium hover:opacity-90 ${tone}`}
                  data-testid="status-engine-health"
                  data-engine-state={state}
                  title={engineHealth?.message ?? "Lane engine status (loading)"}
                >
                  <span className={`inline-block h-2 w-2 rounded-full ${dotTone}`} />
                  {label}
                </a>
              </Link>
            );
          })()}
          {/* Task #967 — shared live-sync health pill. */}
          <LiveSyncPill testId="pill-live-sync-lwq" />
          <HiddenCountsDisclosure
            summary={hiddenCountsSummary}
            surface="lwq"
            testId="disclosure-hidden-lwq"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={() => setShowShortcutsHelp(true)}
            data-testid="btn-keyboard-help-lwq"
            title="Keyboard shortcuts (?)"
          >
            ?
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5 border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
            onClick={() => setBuildLaneOpen(true)}
            data-testid="btn-build-lane"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            Build Lane
          </Button>
          {/* Task #1030 — Leak Console link moved to /admin/lane-engine. */}
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={() => setSharingOpen(true)}
            data-testid="btn-manage-sharing"
            title="Add a teammate as a collaborator on one of your accounts"
          >
            <User className="w-3.5 h-3.5" />
            Manage Sharing
          </Button>
          {/*
            Workflow OS — Task #917. Canonical left-to-right filter row:
              [ Owner ] [ Customer ] [ Pickup scope ] [ Stale-N chip ] [ My lanes today ]
            See docs/workflow-os-spec.md sections A & G. The bucket sections
            below remain LWQ's status grammar — they're not duplicated here.
          */}
          {/*
            Task #1028 (LWQ C) — Primary mode selector. Drives the page's
            mental model (Strategic / Outreach / Triage / Admin). Triage
            and Admin entries are hidden when the current role can't
            access them so the dropdown reflects what's actually
            reachable. The hidden `text-lwq-mode-active` span is the
            E2E-stable readout the guardrail and Playwright tests pin.
          */}
          <Select value={mode} onValueChange={(v) => {
            if (!isLwqMode(v)) return;
            if (!canAccessLwqMode(user?.role, v)) return;
            setMode(v);
          }}>
            <SelectTrigger className="h-8 text-xs w-44 gap-1" data-testid="select-lwq-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="strategic" data-testid="option-mode-strategic">Mode: Strategic</SelectItem>
              <SelectItem value="outreach" data-testid="option-mode-outreach">Mode: Outreach</SelectItem>
              {canAccessLwqMode(user?.role, "triage") && (
                <SelectItem value="triage" data-testid="option-mode-triage">Mode: Triage</SelectItem>
              )}
              {canAccessLwqMode(user?.role, "admin") && (
                <SelectItem value="admin" data-testid="option-mode-admin">Mode: Admin</SelectItem>
              )}
            </SelectContent>
          </Select>
          <span className="sr-only" data-testid="text-lwq-mode-active">{mode}</span>
          <OwnerFilterSelect
            value={ownerFilter}
            onChange={setOwnerFilter}
            orgUsers={teamMembers}
            currentUser={user ? { id: user.id, name: user.name, role: user.role } : null}
            surface="lwq"
            className="h-8 text-xs w-40 gap-1"
          />
          {/* Customer filter dropdown */}
          {(queue?.customers?.length ?? 0) > 0 && (
            <Select
              value={customerFilter}
              onValueChange={setCustomerFilter}
              data-testid="select-customer-filter"
            >
              <SelectTrigger className="h-8 text-xs w-44 gap-1">
                <Filter className="w-3 h-3 shrink-0 text-muted-foreground" />
                <SelectValue placeholder="All customers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All customers</SelectItem>
                {[...(queue?.customers ?? [])]
                  // Sort by the cleaned label so the dropdown order matches what
                  // the user sees, not the raw "BLOOSACA - bloom energy" key.
                  .sort((a, b) => formatCustomerName(a).localeCompare(formatCustomerName(b)))
                  .map(name => (
                    <SelectItem key={name} value={name}>{formatCustomerName(name)}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
          )}
          <PickupScopeSelect
            value={pickupScope}
            onChange={setPickupScope}
            className="h-8 text-xs w-44 gap-1"
          />
          {/*
            Task #1027 (LWQ B) — opt-in Strategic sort. Default mode keeps
            the legacy signal-tiered ordering so reps see no surprise. When
            toggled, the page passes ?sort=strategic and the server attaches
            the composite + sorts each bucket by it; the client stops
            re-sorting unassigned. Weights are admin-tunable on
            /admin/carrier-intelligence-scoring.
          */}
          {/*
            Task #1028 (LWQ C) — Sort selector is hidden in Strategic mode
            (sort is forced to `strategic`) and Outreach mode (sort is
            forced to reply-urgency on the server). It remains visible in
            Triage + Admin so power users still control row order there.
          */}
          {(mode === "triage" || mode === "admin") && (
            <Select value={sortMode} onValueChange={(v) => setSortMode(v as LwqSortMode)}>
              <SelectTrigger className="h-8 text-xs w-40 gap-1" data-testid="select-lwq-sort-mode">
                <SelectValue placeholder="Sort: Default" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default" data-testid="option-sort-default">Sort: Default</SelectItem>
                <SelectItem value="strategic" data-testid="option-sort-strategic">Sort: Strategic</SelectItem>
              </SelectContent>
            </Select>
          )}
          <StaleCountChip
            hiddenStale={queue?.hiddenStale ?? 0}
            currentScope={pickupScope}
            onShowAll={() => setPickupScope("all")}
          />
          {/*
            Workflow OS — built-in "My lanes today" saved view (spec
            section G). One-click chip so reps can land on their actionable
            slice without learning the filter combinatorics.
          */}
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={applyMyLanesTodayView}
            data-testid="btn-saved-view-my-lanes-today"
            title="Owner = me, Pickup scope = actionable"
          >
            <Sparkles className="w-3.5 h-3.5" />
            My lanes today
          </Button>
          {/* Task #1085 — Recurring lane filter (≥6 moved loads in last 30d) */}
          <Button
            variant={recurring30dOnly ? "default" : "outline"}
            size="sm"
            className={`h-8 text-xs gap-1.5 ${recurring30dOnly ? "bg-amber-500 hover:bg-amber-600 text-white border-transparent" : ""}`}
            onClick={() => setRecurring30dOnly(v => !v)}
            data-testid="btn-filter-high-freq"
          >
            <Zap className="w-3.5 h-3.5" />
            6× / 30d{recurring30dCount > 0 && ` (${recurring30dCount})`}
          </Button>
          {/* Manual lanes filter toggle */}
          <Button
            variant={manualOnly ? "default" : "outline"}
            size="sm"
            className={`h-8 text-xs gap-1.5 ${manualOnly ? "bg-blue-500 hover:bg-blue-600 text-white border-transparent" : ""}`}
            onClick={() => setManualOnly(v => !v)}
            data-testid="btn-filter-manual"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            Manual{manualLaneCount > 0 && ` (${manualLaneCount})`}
          </Button>
          {/* Task #1030 — Run Engine button moved to /admin/lane-engine. */}
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={() => refetch()}
            data-testid="btn-refresh-work-queue"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 md:py-6">
        {isError ? (
          <QueryError message="Couldn't load the lane work queue. This is usually temporary." onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="space-y-4" data-testid="lwq-skeleton">
            {/* Summary stat chips skeleton */}
            <div className="flex gap-3 flex-wrap mb-6">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="rounded-lg border border-border px-3 py-2 min-w-[80px]">
                  <Skeleton className="h-7 w-10 mx-auto mb-1" />
                  <Skeleton className="h-2.5 w-14 mx-auto" />
                </div>
              ))}
            </div>
            {/* Bucket skeleton */}
            {[...Array(2)].map((_, bucketIdx) => (
              <div key={bucketIdx} className="mb-6">
                <Skeleton className="h-5 w-40 mb-3" />
                <div className="rounded-lg border border-border bg-card overflow-hidden">
                  <Skeleton className="h-12 w-full" />
                  <div className="flex flex-col gap-1 px-2 pb-2 pt-2 border-t border-border/50 bg-muted/10">
                    {[...Array(3)].map((_, rowIdx) => (
                      <div key={rowIdx} className="flex gap-3 items-start p-3 rounded-md">
                        <div className="flex-1 space-y-2">
                          <Skeleton className="h-4 w-48" />
                          <div className="flex gap-2">
                            <Skeleton className="h-4 w-16" />
                            <Skeleton className="h-4 w-16" />
                          </div>
                          <Skeleton className="h-3 w-32" />
                        </div>
                        <Skeleton className="h-8 w-24 shrink-0" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            {/* Active filter chip strip — surfaces every active filter in one
                place with inline remove buttons, plus a Clear all when ≥ 2
                are active. Hidden entirely when no filters are on so it
                doesn't take vertical space on the default view. */}
            {activeFilterCount > 0 && (
              <div
                className="flex gap-2 flex-wrap items-center mb-4"
                data-testid="active-filter-chips"
              >
                <span className="text-xs text-muted-foreground mr-1">Filters:</span>
                {recurring30dOnly && (
                  <button
                    onClick={() => setRecurring30dOnly(false)}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs hover:bg-amber-500/25 transition-colors"
                    data-testid="chip-filter-recurring-30d"
                    title="Remove 6× / 30d filter"
                  >
                    <Zap className="w-3 h-3" />
                    <span>6× / 30d</span>
                    <X className="w-3 h-3" />
                  </button>
                )}
                {manualOnly && (
                  <button
                    onClick={() => setManualOnly(false)}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/15 border border-blue-500/30 text-blue-300 text-xs hover:bg-blue-500/25 transition-colors"
                    data-testid="chip-filter-manual"
                    title="Remove Manual filter"
                  >
                    <PlusCircle className="w-3 h-3" />
                    <span>Manual only</span>
                    <X className="w-3 h-3" />
                  </button>
                )}
                {customerFilter !== "__all__" && (
                  <button
                    onClick={() => setCustomerFilter("__all__")}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-purple-500/15 border border-purple-500/30 text-purple-300 text-xs hover:bg-purple-500/25 transition-colors max-w-[260px]"
                    data-testid="chip-filter-customer"
                    title="Remove customer filter"
                  >
                    <Filter className="w-3 h-3 shrink-0" />
                    <span className="truncate">{formatCustomerName(customerFilter)}</span>
                    <X className="w-3 h-3 shrink-0" />
                  </button>
                )}
                {activeFilterCount >= 2 && (
                  <button
                    onClick={clearAllFilters}
                    className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline ml-1"
                    data-testid="btn-clear-all-filters"
                  >
                    Clear all
                  </button>
                )}
              </div>
            )}

            {/* Summary stat chips — reflect filtered counts. Task #1028
                (LWQ C): tiles are mode-scoped so the chip strip always
                reconciles with the buckets actually rendered below.
                  strategic / outreach → Untouched + In Progress
                  triage               → Unassigned + No Contact Info
                  admin                → all four */}
            {filteredQueue && (
              <div className="flex gap-3 flex-wrap mb-6" data-testid="strip-lwq-summary-tiles">
                {(mode === "triage" || mode === "admin") && (
                  <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]" data-testid="tile-lwq-unassigned">
                    <p className="text-lg font-bold text-orange-400">{filteredQueue.unassigned.length}</p>
                    <p className="text-[10px] text-orange-400/70">Unassigned</p>
                  </div>
                )}
                {(mode === "triage" || mode === "admin") && (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]" data-testid="tile-lwq-no-contact">
                    <p className="text-lg font-bold text-red-400">{filteredQueue.noContactable.length}</p>
                    <p className="text-[10px] text-red-400/70">No Contact Info</p>
                  </div>
                )}
                {(mode === "strategic" || mode === "outreach" || mode === "admin") && (
                  <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]" data-testid="tile-lwq-untouched">
                    <p className="text-lg font-bold text-blue-400">{filteredQueue.assignedUntouched.length}</p>
                    <p className="text-[10px] text-blue-400/70">Untouched</p>
                  </div>
                )}
                {(mode === "strategic" || mode === "outreach" || mode === "admin") && (
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]" data-testid="tile-lwq-inprogress">
                    <p className="text-lg font-bold text-amber-400">{filteredQueue.inProgress.length}</p>
                    <p className="text-[10px] text-amber-400/70">In Progress</p>
                  </div>
                )}
                {/* Task #1085 — Recurring (≥6 / 30d) summary chip */}
                {recurring30dCount > 0 && (
                  <button
                    className={`flex items-center gap-1.5 border rounded-lg px-3 py-2 text-center min-w-[80px] transition-colors ${
                      recurring30dOnly
                        ? "bg-amber-500/20 border-amber-500/40"
                        : "bg-amber-500/10 border-amber-500/20 hover:border-amber-500/40"
                    }`}
                    onClick={() => setRecurring30dOnly(v => !v)}
                    data-testid="btn-highfreq-chip"
                  >
                    <Zap className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <div>
                      <p className="text-lg font-bold text-amber-400 leading-none">{recurring30dCount}</p>
                      <p className="text-[10px] text-amber-400/70">6× / 30d</p>
                    </div>
                  </button>
                )}
              </div>
            )}

            {/* Send & Reply Audit — visible to all reps; managers can swap rep */}
            {user && (
              <SendReplyAuditPanel
                currentUser={{ id: user.id, name: user.name, role: user.role }}
                isManager={isManagerScope}
                teamMembers={teamMembers}
              />
            )}

            {/* Task #1030 — engine-debug-panel and sourcing-performance-panel
                relocated to /admin/lane-engine. */}

            {/*
              Task #1028 (LWQ C) — Mode-scoped bucket rendering.
                strategic → Untouched + In Progress (assigned lanes the rep
                            can act on; ranked by Task B's strategicPriority)
                outreach  → Untouched + In Progress as a single flat list
                            (server already sorted each by hotReplyCount)
                triage    → Unassigned + No Contactable (intake / hygiene)
                admin     → all four buckets PLUS the link block to
                            /admin/lane-engine where Run Engine, Leak
                            Console and per-row Edit/Delete live (Task E).
              The four BucketSection renders are intentionally repeated
              per mode (rather than a helper) so guardrails can keep
              pinning their data-testids by literal substring.
            */}
            {filteredQueue && (mode === "strategic" || mode === "admin") && (
              <BucketSection
                title="Assigned — Untouched"
                description="Owner assigned and carriers are contactable — no outreach logged yet."
                icon={Truck}
                iconColor="bg-blue-500/10 text-blue-400"
                items={filteredQueue.assignedUntouched}
                completionThreshold={completionThreshold}
                onOpen={setOpenLaneId}
                onOpenCockpit={openCockpitForLane}
                bucket="assignedUntouched"
                teamMembers={teamMembers}
                recurring30dOnly={recurring30dOnly}
                selectedLaneIds={selectedLaneIds}
                onToggleSelect={handleToggleSelect}
                votriByLane={votriByLane}
                preserveServerOrder={mode === "strategic"}
              />
            )}
            {filteredQueue && (mode === "strategic" || mode === "admin") && (
              <BucketSection
                title="In Progress"
                description="Outreach started — keep going to hit the target."
                icon={CheckCircle2}
                iconColor="bg-amber-500/10 text-amber-400"
                items={filteredQueue.inProgress}
                completionThreshold={completionThreshold}
                onOpen={setOpenLaneId}
                onOpenCockpit={openCockpitForLane}
                bucket="inProgress"
                teamMembers={teamMembers}
                recurring30dOnly={recurring30dOnly}
                selectedLaneIds={selectedLaneIds}
                onToggleSelect={handleToggleSelect}
                votriByLane={votriByLane}
                preserveServerOrder={mode === "strategic"}
              />
            )}
            {filteredQueue && mode === "outreach" && (
              <BucketSection
                title="Reply Urgency"
                description="Lanes with Hot replies first, then awaiting follow-ups, then untouched contactable lanes. Sorted by hot-reply count desc."
                icon={CheckCircle2}
                iconColor="bg-amber-500/10 text-amber-400"
                items={outreachFlatItems}
                completionThreshold={completionThreshold}
                onOpen={setOpenLaneId}
                onOpenCockpit={openCockpitForLane}
                bucket="inProgress"
                teamMembers={teamMembers}
                recurring30dOnly={recurring30dOnly}
                selectedLaneIds={selectedLaneIds}
                onToggleSelect={handleToggleSelect}
                votriByLane={votriByLane}
                preserveServerOrder
                flatList
              />
            )}
            {filteredQueue && (mode === "triage" || mode === "admin") && (
              <BucketSection
                title="Unassigned"
                description={
                  recurring30dOnly
                    ? "Showing lanes with ≥6 moves in the last 30d — highest procurement priority."
                    : "These lanes have no owner — assign one to get outreach started. Sorted highest frequency first."
                }
                icon={UserX}
                iconColor="bg-orange-500/10 text-orange-400"
                items={sortedUnassigned}
                completionThreshold={completionThreshold}
                onOpen={setOpenLaneId}
                onOpenCockpit={openCockpitForLane}
                bucket="unassigned"
                teamMembers={teamMembers}
                recurring30dOnly={recurring30dOnly}
                selectedLaneIds={selectedLaneIds}
                onToggleSelect={handleToggleSelect}
                votriByLane={votriByLane}
              />
            )}
            {filteredQueue && (mode === "triage" || mode === "admin") && (
              <BucketSection
                title="No Contactable Carriers"
                description="Assigned but carriers have no phone or email — update the carrier catalog."
                icon={AlertCircle}
                iconColor="bg-red-500/10 text-red-400"
                items={filteredQueue.noContactable}
                completionThreshold={completionThreshold}
                onOpen={setOpenLaneId}
                onOpenCockpit={openCockpitForLane}
                bucket="noContactable"
                teamMembers={teamMembers}
                recurring30dOnly={recurring30dOnly}
                selectedLaneIds={selectedLaneIds}
                onToggleSelect={handleToggleSelect}
                votriByLane={votriByLane}
              />
            )}
            {/*
              Task #1028 (LWQ C) — Admin mode link block. The engine
              console itself lives at /admin/lane-engine (Task #1030);
              this block is a permanent jump-off so admins don't have
              to remember the URL. Hidden in every other mode so the
              rep daily view stays focused.
            */}
            {mode === "admin" && (
              <div
                className="rounded-lg border border-border bg-card px-4 py-3 mb-6 flex flex-col gap-2"
                data-testid="block-lwq-admin-links"
              >
                <div>
                  <p className="text-sm font-semibold text-foreground mb-1">Admin tools</p>
                  <p className="text-xs text-muted-foreground">
                    Run Engine, Leak Console, source-freshness, scoring weights,
                    KPIs, and per-row Edit / Delete live on the Lane Engine
                    console (Task&nbsp;#1030). Admin mode also unhides Unassigned
                    and No Contactable above so you can review them in one pass.
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <Link href="/admin/lane-engine">
                    <a
                      className="inline-flex items-center gap-1.5 text-xs text-amber-400 hover:underline"
                      data-testid="link-lwq-admin-lane-engine"
                    >
                      Open Lane Engine console →
                    </a>
                  </Link>
                  <Link href="/admin/lane-engine?panel=leak">
                    <a
                      className="inline-flex items-center gap-1.5 text-xs text-amber-400 hover:underline"
                      data-testid="link-lwq-admin-leak-console"
                    >
                      Open Leak Console →
                    </a>
                  </Link>
                  <Link href="/admin/carrier-intelligence-scoring">
                    <a
                      className="inline-flex items-center gap-1.5 text-xs text-amber-400 hover:underline"
                      data-testid="link-lwq-admin-scoring-weights"
                    >
                      Edit scoring weights →
                    </a>
                  </Link>
                </div>
              </div>
            )}

            {!isLoading && totalLanes === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                {isAdminOrDirector ? (
                  <>
                    <Database className="w-10 h-10 text-emerald-400 mb-3" />
                    <p className="text-sm font-semibold text-foreground">No lanes scored yet</p>
                    <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                      The lane capacity engine hasn't run against your TMS upload data yet.
                      Open the Lane Engine console to trigger a run.
                    </p>
                    <Link href="/admin/lane-engine">
                      <Button
                        size="sm"
                        className="mt-4 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                        data-testid="btn-open-lane-engine-empty"
                      >
                        <Database className="w-3.5 h-3.5" />
                        Open Lane Engine
                      </Button>
                    </Link>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-10 h-10 text-emerald-400 mb-3" />
                    <p className="text-sm font-semibold text-foreground">All caught up!</p>
                    <p className="text-xs text-muted-foreground mt-1">No eligible lanes need attention right now.</p>
                  </>
                )}
              </div>
            )}

            {/* Task #1030 — admin-debug-panel relocated to /admin/lane-engine. */}
          </>
        )}
      </div>

      {/* Workflow OS Task #917 — canonical BulkActionBar. LWQ exposes
          only "Reassign" today; surfaces omit canonical actions they
          don't own. */}
      <BulkActionBar
        count={selection.selectedCount}
        selectedIds={selection.selectedIds}
        busy={bulkAssignMutation.isPending || bulkSnoozeMutation.isPending}
        onClear={() => selection.clear()}
        secondary={[
          {
            id: "snooze-24h",
            label: bulkSnoozeMutation.isPending ? "Snoozing…" : "Snooze 24h",
            icon: Clock,
            testId: "button-bulk-snooze-24h",
            onSelect: () =>
              bulkSnoozeMutation.mutate({
                laneIds: selection.selectedIds.slice(),
                durationHours: 24,
              }),
            // Snooze is available against any selection — every recurring
            // lane has a snoozedUntil column. The eligibility predicate is
            // intentionally permissive here; the server enforces org
            // membership per id and reports per-id failures back.
            availability: ({ selectedCount }) =>
              selectedCount > 0
                ? { state: "available" }
                : { state: "unavailable", reason: "Select lanes first" },
          },
        ]}
        primary={{
          id: "reassign",
          label: bulkAssignMutation.isPending ? "Assigning…" : "Reassign",
          testId: "button-bulk-assign-confirm",
          // The inline picker (`render`) owns the actual mutation trigger;
          // the no-op default keeps the BulkAction contract satisfied for
          // headless callers (cheat sheet, future kbd shortcuts).
          onSelect: () => undefined,
          availability: { state: "available" },
          // Custom render so the action can own its inline owner picker.
          render: ({ disabled }) => {
            // Resolve the picked candidate against `summarizeBulkAssign`
            // so the bar can surface "5 of 7 eligible" inline plus the
            // override flow when the rep tries to commit.
            const candidate = teamMembers.find(m => m.id === bulkAssignUserId);
            // Index team members by id so each lane's team can be
            // derived from its current owner. Lanes whose owner has no
            // team membership get `teamId: null` and the predicate
            // skips the team check.
            const memberById = new Map<string, TeamMember>();
            for (const m of teamMembers) memberById.set(m.id, m);
            const allLanes = filteredQueue
              ? [
                  ...filteredQueue.unassigned,
                  ...filteredQueue.noContactable,
                  ...filteredQueue.assignedUntouched,
                  ...filteredQueue.inProgress,
                ]
              : [];
            const selectedLanes = selection.selectedIds
              .map(id => allLanes.find(l => l.laneId === id))
              .filter((l): l is LaneItem => !!l)
              .map(l => {
                const owner = l.ownerUserId
                  ? memberById.get(l.ownerUserId) ?? null
                  : null;
                return {
                  laneId: l.laneId,
                  ownerUserId: l.ownerUserId,
                  teamId: owner?.teamId ?? null,
                  teamLabel: owner?.teamLabel ?? null,
                };
              });
            const summary = candidate
              ? summarizeBulkAssign(selectedLanes, {
                  id: candidate.id,
                  name: candidate.name,
                  role: candidate.role,
                  teamId: candidate.teamId ?? null,
                  teamLabel: candidate.teamLabel ?? null,
                })
              : null;
            const fullyEligible =
              summary === null || summary.eligibleCount === summary.totalCount;
            const fullyIneligible =
              !!summary && summary.eligibleCount === 0;
            const showOverridePrompt =
              !!summary && !fullyEligible && bulkAssignOverride === null;
            return (
              <div className="flex flex-col gap-1" data-testid="bulk-reassign-control">
                <div className="flex items-center gap-2">
                  <select
                    className="rounded-md border border-border bg-background text-sm px-2 py-1.5 text-foreground"
                    value={bulkAssignUserId}
                    onChange={e => {
                      setBulkAssignUserId(e.target.value);
                      setBulkAssignOverride(null);
                    }}
                    disabled={disabled}
                    data-testid="select-bulk-assign-user"
                  >
                    <option value="">Assign to…</option>
                    {teamMembers.map(m => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                  {summary && !fullyEligible && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/40"
                          data-testid="badge-bulk-assign-availability"
                        >
                          {summary.eligibleCount} of {summary.totalCount} eligible
                        </span>
                      </TooltipTrigger>
                      <TooltipContent
                        side="top"
                        className="text-xs max-w-[260px]"
                        data-testid="tooltip-bulk-assign-availability"
                      >
                        {summary.firstReason ?? "Some lanes aren't structurally eligible for this owner."}
                      </TooltipContent>
                    </Tooltip>
                  )}
                  <Button
                    size="sm"
                    variant="default"
                    className="h-8 text-xs gap-1"
                    onClick={() => {
                      if (!candidate || !bulkAssignUserId) return;
                      if (fullyEligible) {
                        bulkAssignMutation.mutate({
                          laneIds: selection.selectedIds.slice(),
                          ownerUserId: bulkAssignUserId,
                        });
                        return;
                      }
                      // Open the inline override prompt instead of firing.
                      setBulkAssignOverride({
                        candidateId: candidate.id,
                        candidateName: candidate.name,
                        reason:
                          summary?.firstReason ??
                          "Selection contains lanes outside the candidate's outreach scope.",
                        rationale: "",
                      });
                    }}
                    disabled={disabled || !bulkAssignUserId || fullyIneligible && !showOverridePrompt}
                    data-testid="button-bulk-assign-confirm"
                  >
                    {bulkAssignMutation.isPending ? "Assigning…" : "Reassign"}
                  </Button>
                </div>
                {bulkAssignOverride && (
                  <div
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/30"
                    data-testid="bulk-assign-override-row"
                  >
                    <span className="text-[11px] text-amber-300 leading-snug max-w-[260px]">
                      {bulkAssignOverride.reason}
                    </span>
                    <Input
                      value={bulkAssignOverride.rationale}
                      onChange={e =>
                        setBulkAssignOverride(prev =>
                          prev ? { ...prev, rationale: e.target.value } : prev,
                        )
                      }
                      placeholder="Reason (logged)"
                      className="h-7 text-[11px] w-44"
                      data-testid="input-bulk-assign-override-reason"
                    />
                    <Button
                      size="sm"
                      variant="default"
                      className="h-7 text-[11px] px-2"
                      onClick={() =>
                        bulkAssignMutation.mutate({
                          laneIds: selection.selectedIds.slice(),
                          ownerUserId: bulkAssignOverride.candidateId,
                          assignAnyway: true,
                          overrideReason:
                            bulkAssignOverride.rationale.trim() ||
                            bulkAssignOverride.reason,
                        })
                      }
                      disabled={disabled}
                      data-testid="button-bulk-assign-override-confirm"
                    >
                      Assign anyway
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px] px-2"
                      onClick={() => setBulkAssignOverride(null)}
                      data-testid="button-bulk-assign-override-cancel"
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            );
          },
        }}
      />

      {/* Build Lane dialog */}
      <BuildLaneDialog
        open={buildLaneOpen}
        onClose={() => {
          setBuildLaneOpen(false);
          // Task #653 — clear AF prefill state and strip the deep-link
          // params so a refresh or back-nav doesn't re-pop the dialog.
          if (buildLanePrefill) {
            setBuildLanePrefill(null);
            clearBuildLanePrefillFromUrl();
          }
        }}
        onCreated={() => {
          // Task #653 — same cleanup on successful save (the dialog also
          // calls onClose, but we clear here too to be defensive).
          if (buildLanePrefill) {
            setBuildLanePrefill(null);
            clearBuildLanePrefillFromUrl();
          }
        }}
        currentUser={user ? { id: user.id, name: user.name } : null}
        teamMembers={teamMembers}
        isAdminOrDirector={isAdminOrDirector}
        prefill={buildLanePrefill}
      />

      {/* Account sharing dialog */}
      <AccountSharingDialog open={sharingOpen} onOpenChange={setSharingOpen} />

      {/* Outreach panel */}
      <CarrierOutreachPanel
        laneId={openLaneId}
        open={!!openLaneId}
        onClose={() => setOpenLaneId(null)}
        onCarriersContacted={() => {
          setOpenLaneId(null);
          queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
        }}
      />

      {/* Task #871 — Lane Cockpit overlay (single round-trip) */}
      <LaneCockpitSheet
        signature={cockpitSignature}
        laneLabel={cockpitLaneLabel}
        openedFrom="lwq"
        open={cockpitOpen}
        onOpenChange={(o) => {
          setCockpitOpen(o);
          if (!o) setCockpitSignature(null);
        }}
      />

      {/* Task #871 — keyboard cheat sheet (sourced from the shared registry
          so the help dialog and the actual handlers can never disagree). */}
      <Dialog open={showShortcutsHelp} onOpenChange={setShowShortcutsHelp}>
        <DialogContent data-testid="dialog-keyboard-help-lwq" className="max-w-md">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>
              These hot keys work across the Lane Work Queue and Available Freight.
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm">
            <ul className="divide-y divide-border">
              {sharedCheatRows.map(row => (
                <li
                  key={row.key}
                  className="py-2 flex items-center justify-between"
                  data-testid={`row-cheat-${row.key === "?" ? "help" : row.key}`}
                >
                  <span>{row.label}</span>
                  <kbd className="px-2 py-0.5 rounded border border-border bg-muted text-xs">
                    {row.key === " " ? "Space" : row.key}
                  </kbd>
                </li>
              ))}
            </ul>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
