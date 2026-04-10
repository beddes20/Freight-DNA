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
 */

import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { formatLaneDisplay, formatWeeklyLoadRange } from "@shared/laneFormatters";
import { Badge } from "@/components/ui/badge";
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
  Play,
  Building2,
  Filter,
  Database,
  PlusCircle,
  Shield,
  TrendingUp,
  Trash2,
  Pencil,
  X,
  MessageCircle,
} from "lucide-react";
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
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@tanstack/react-query";
import { InfoTooltip } from "@/components/info-tooltip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  resolveLaneLocationWithConfidence,
  normalizeStateAbbr,
  type NormalizationResult,
} from "@/lib/laneLocationNormalizer";

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
  lane: {
    id: string;
    origin: string;
    originState: string | null;
    destination: string;
    destinationState: string | null;
    equipmentType: string | null;
    avgLoadsPerWeek: string | null;
    laneScore: number | null;
    eligibilityConfidence: string;
    companyId: string | null;
    companyName: string | null;
    carriersContactedCount: number | null;
    ownerUserId: string | null;
    ownerName: string | null;
    assignedAt: string | null;
    isManual: boolean;
  };
  contactableCount: number;
  totalBenchCount: number;
  historicalCount: number;
  missingContactCount: number;
  replySummary?: LaneReplySummary;
}

interface WorkQueue {
  unassigned: LaneItem[];
  noContactable: LaneItem[];
  assignedUntouched: LaneItem[];
  inProgress: LaneItem[];
  scopeLabel?: string;
  customers?: string[];  // distinct customer names from all visible lanes (for filter dropdown)
}

interface EngineRunMeta {
  source: "financial_uploads";
  uploadIds: string[];
  latestUploadDate: string;
  rowsScanned: number;
  lanesGenerated: number;
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const HIGH_FREQ_THRESHOLD = 2; // loads/week — main procurement priority

function laneLabel(item: LaneItem["lane"]) {
  return formatLaneDisplay(item.origin, item.originState, item.destination, item.destinationState);
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

/** Sort items — high-frequency first, then by laneScore descending */
function sortItems(items: LaneItem[]): LaneItem[] {
  return [...items].sort((a, b) => {
    const aFreq = avgLoadsNum(a.lane.avgLoadsPerWeek);
    const bFreq = avgLoadsNum(b.lane.avgLoadsPerWeek);
    if (bFreq !== aFreq) return bFreq - aFreq;
    return (b.lane.laneScore ?? 0) - (a.lane.laneScore ?? 0);
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
  teamMembers,
  onAssigned,
}: {
  laneId: string;
  teamMembers: TeamMember[];
  onAssigned: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const assignMutation = useMutation({
    mutationFn: (ownerUserId: string) =>
      apiRequest("POST", `/api/recurring-lanes/${laneId}/assign`, { ownerUserId }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: "Lane assigned" });
      setOpen(false);
      onAssigned();
    },
    onError: (err: unknown) => {
      const msg = (err as { message?: string })?.message ?? "Assignment failed";
      toast({ title: msg, variant: "destructive" });
    },
  });

  // Assignable roles: people who actually do outreach
  const assignable = teamMembers.filter(m =>
    ["account_manager", "logistics_manager", "logistics_coordinator", "sales"].includes(m.role)
  );

  if (assignable.length === 0) return null;

  return (
    <div className="relative" onClick={e => e.stopPropagation()}>
      <Button
        size="sm"
        variant="outline"
        className="h-6 text-[10px] px-2 border-amber-400/30 text-amber-400 hover:bg-amber-500/10 gap-1"
        onClick={() => setOpen(v => !v)}
        disabled={assignMutation.isPending}
        data-testid={`btn-assign-to-${laneId}`}
      >
        {assignMutation.isPending
          ? <Loader2 className="w-3 h-3 animate-spin" />
          : <><User className="w-3 h-3" />Assign to…<ChevronDown className="w-3 h-3" /></>
        }
      </Button>
      {open && (
        <div className="absolute left-0 top-7 z-50 bg-card border border-border rounded-lg shadow-lg min-w-[180px] py-1 max-h-48 overflow-y-auto">
          {assignable.map(m => (
            <button
              key={m.id}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/60 transition-colors flex items-center gap-2"
              onClick={() => assignMutation.mutate(m.id)}
              data-testid={`assign-option-${laneId}-${m.id}`}
            >
              <User className="w-3 h-3 text-muted-foreground shrink-0" />
              <span className="truncate">{m.name}</span>
              <span className="text-[10px] text-muted-foreground/60 shrink-0 ml-auto">
                {m.role === "account_manager" ? "AM" : m.role === "logistics_manager" ? "LM" : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Lane Row ──────────────────────────────────────────────────────────────────

const MANAGER_ROLES = ["admin", "director", "national_account_manager", "logistics_manager"];

function LaneRow({
  item,
  completionThreshold,
  onOpen,
  bucket,
  teamMembers,
}: {
  item: LaneItem;
  completionThreshold: number;
  onOpen: (laneId: string) => void;
  bucket: keyof WorkQueue;
  teamMembers: TeamMember[];
}) {
  const { toast } = useToast();
  const { user: currentUser } = useAuth();
  const isManager = MANAGER_ROLES.includes(currentUser?.role ?? "");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    origin: item.lane.origin ?? "",
    originState: item.lane.originState ?? "",
    destination: item.lane.destination ?? "",
    destinationState: item.lane.destinationState ?? "",
    equipmentType: item.lane.equipmentType ?? "",
    avgLoadsPerWeek: item.lane.avgLoadsPerWeek ?? "",
    companyName: item.lane.companyName ?? "",
  });

  const selfAssignMutation = useMutation({
    mutationFn: (ownerUserId: string | null) =>
      apiRequest("POST", `/api/recurring-lanes/${item.lane.id}/assign`, { ownerUserId }).then(r => r.json()),
    onSuccess: (_data, ownerUserId) => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: ownerUserId === null ? "Lane unassigned" : "Lane assigned" });
    },
    onError: () => toast({ title: "Assignment failed", variant: "destructive" }),
  });

  const canUnassign = item.lane.ownerUserId &&
    (isManager || item.lane.ownerUserId === currentUser?.id);

  const canDelete = isManager || item.lane.ownerUserId === currentUser?.id;

  const deleteMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/recurring-lanes/${item.lane.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: "Lane deleted" });
      setDeleteDialogOpen(false);
    },
    onError: () => toast({ title: "Failed to delete lane", variant: "destructive" }),
  });

  const editMutation = useMutation({
    mutationFn: (data: typeof editForm) =>
      apiRequest("PATCH", `/api/recurring-lanes/${item.lane.id}`, {
        origin: data.origin.trim() || undefined,
        originState: data.originState.trim() || null,
        destination: data.destination.trim() || undefined,
        destinationState: data.destinationState.trim() || null,
        equipmentType: data.equipmentType.trim() || null,
        avgLoadsPerWeek: data.avgLoadsPerWeek !== "" ? data.avgLoadsPerWeek : null,
        companyName: data.companyName.trim() || null,
      }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: "Lane updated" });
      setEditDialogOpen(false);
    },
    onError: () => toast({ title: "Failed to update lane", variant: "destructive" }),
  });

  const { data: coverageData } = useQuery<{ profile: CoverageProfile; carriers: CoverageProfileCarrier[] }>({
    queryKey: ["/api/lanes", item.lane.id, "coverage-profile"],
    queryFn: () => fetch(`/api/lanes/${item.lane.id}/coverage-profile`).then(r => r.ok ? r.json() : null),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const contacted = item.lane.carriersContactedCount ?? 0;
  const progressPct = Math.min(100, (contacted / completionThreshold) * 100);
  const loadsNum = avgLoadsNum(item.lane.avgLoadsPerWeek);
  // Prefer server-stamped isHighFrequency (Task #188) with avgLoadsPerWeek as fallback
  const isHighFreq = (item.lane as { isHighFrequency?: boolean }).isHighFrequency
    ?? (loadsNum >= HIGH_FREQ_THRESHOLD);

  const hasHotReply = (item.replySummary?.hotCount ?? 0) > 0;
  const replyNeedsAction = item.replySummary?.needsAction ?? false;

  return (
    <div
      className={`bg-card border rounded-lg p-4 hover:border-amber-500/30 transition-colors cursor-pointer group ${
        // Green border for any hot lane — full brightness if needsAction (unactioned), dimmer if already actioned
        hasHotReply
          ? replyNeedsAction
            ? "border-green-500/40 bg-green-950/5"
            : "border-green-700/30 bg-green-950/3"
          : isHighFreq
            ? "border-amber-500/20"
            : "border-border"
      }`}
      onClick={() => onOpen(item.lane.id)}
      data-testid={`work-queue-row-${item.lane.id}`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {/* Customer name — always shown first, prominent */}
          {item.lane.companyName && (
            <div className="flex items-center gap-1.5 mb-1.5">
              <Building2 className="w-3 h-3 text-blue-400 shrink-0" />
              <span className="text-xs font-semibold text-blue-500 dark:text-blue-400">{item.lane.companyName}</span>
              {/* CRM match indicator: show 'CRM' badge if companyId resolved, otherwise 'customer name' fallback */}
              {item.lane.companyId ? (
                <Badge variant="outline" className="text-[9px] py-0 px-1 border-blue-500/30 text-blue-400 bg-blue-500/10">CRM</Badge>
              ) : (
                <Badge variant="outline" className="text-[9px] py-0 px-1 border-slate-500/30 text-muted-foreground" title="Customer name from TMS — not yet matched to a CRM account">TMS name</Badge>
              )}
            </div>
          )}
          {/* Lane label + badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{laneLabel(item.lane)}</span>
            {/* Frequency badge — prominent, always first */}
            <FrequencyBadge val={item.lane.avgLoadsPerWeek} />
            {/* High-frequency lane badge (Task #188): shown when ≥2 loads/week */}
            {isHighFreq && (
              <Badge
                variant="outline"
                className="text-[10px] py-0 px-1.5 border-orange-500/50 text-orange-400 bg-orange-500/10 gap-0.5 font-semibold"
                data-testid={`badge-hf-lane-${item.lane.id}`}
                title="High-frequency lane: 2+ loads/week — enhanced carrier ranking and bulk outreach enabled"
              >
                <Zap className="w-2.5 h-2.5" />
                HF Lane
              </Badge>
            )}
            {item.lane.isManual && (
              <Badge
                variant="outline"
                className="text-[10px] py-0 px-1.5 border-violet-500/50 text-violet-400 bg-violet-500/10"
                data-testid={`badge-manual-${item.lane.id}`}
              >
                Manual
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px] py-0 px-1.5">
              {item.lane.equipmentType ?? "Any"}
            </Badge>
            <Badge variant="outline" className={`text-[10px] py-0 px-1.5 capitalize ${confidenceColor(item.lane.eligibilityConfidence)}`}>
              {item.lane.eligibilityConfidence}
            </Badge>
          </div>

          {/* Coverage status + reply badges */}
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            {coverageData?.profile && (
              <CoverageStatusBadge
                profile={coverageData.profile}
                carriers={coverageData.carriers}
                laneId={item.lane.id}
              />
            )}
            {item.replySummary && item.replySummary.totalReplied > 0 && (
              <ReplyBadge summary={item.replySummary} laneId={item.lane.id} />
            )}
          </div>

          {/* Metrics row */}
          <div className="flex items-center gap-4 mt-2 flex-wrap">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-[11px] text-muted-foreground cursor-help">
                  Score: <span className="text-foreground font-medium">{item.lane.laneScore ?? "—"}</span>
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
              <span className="text-[11px] text-amber-500">
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
                  data-testid={`progress-bar-${item.lane.id}`}
                />
              </div>
            </div>
          )}

          {/* Owner chip + assign controls */}
          <div className="flex items-center gap-2 mt-2 flex-wrap" onClick={e => e.stopPropagation()}>
            {item.lane.ownerName ? (
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground bg-muted/50 border border-border rounded-full px-2 py-0.5">
                <User className="w-3 h-3 text-blue-500" />
                {item.lane.ownerName}
                {item.lane.assignedAt && (
                  <span className="text-[10px] text-muted-foreground/60">
                    · {new Date(item.lane.assignedAt).toLocaleDateString()}
                  </span>
                )}
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
                data-testid={`btn-unassign-${item.lane.id}`}
              >
                {selfAssignMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <><UserX className="w-3 h-3" />Unassign</>}
              </Button>
            )}

            {/* Unassigned lane: show both "Assign to me" (for self) and "Assign to..." dropdown (for managers) */}
            {!item.lane.ownerUserId && currentUser && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] px-2 border-blue-400/30 text-blue-400 hover:bg-blue-500/10"
                  onClick={e => { e.stopPropagation(); selfAssignMutation.mutate(currentUser.id); }}
                  disabled={selfAssignMutation.isPending}
                  data-testid={`btn-assign-self-${item.lane.id}`}
                >
                  {selfAssignMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Assign to me"}
                </Button>
                {isManager && teamMembers.length > 0 && (
                  <AssignToDropdown
                    laneId={item.lane.id}
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
            {canDelete && (
              <button
                className="p-1 rounded hover:bg-amber-500/10 text-muted-foreground hover:text-amber-400"
                onClick={e => { e.stopPropagation(); setEditForm({ origin: item.lane.origin ?? "", originState: item.lane.originState ?? "", destination: item.lane.destination ?? "", destinationState: item.lane.destinationState ?? "", equipmentType: item.lane.equipmentType ?? "", avgLoadsPerWeek: item.lane.avgLoadsPerWeek ?? "", companyName: item.lane.companyName ?? "" }); setEditDialogOpen(true); }}
                data-testid={`btn-edit-lane-${item.lane.id}`}
                title="Edit lane"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            {canDelete && (
              <button
                className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400"
                onClick={e => { e.stopPropagation(); setDeleteDialogOpen(true); }}
                data-testid={`btn-delete-lane-${item.lane.id}`}
                title="Delete lane"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-amber-400 transition-colors" />
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent onClick={e => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete lane?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove <strong>{laneLabel(item.lane)}</strong> from the work queue along with all carrier interest records. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`btn-delete-lane-cancel-${item.lane.id}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              data-testid={`btn-delete-lane-confirm-${item.lane.id}`}
            >
              {deleteMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Delete lane"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit lane dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-lg" onClick={e => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Edit lane</DialogTitle>
            <DialogDescription>Update the details for this lane.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={`edit-origin-${item.lane.id}`}>Origin city</Label>
                <Input
                  id={`edit-origin-${item.lane.id}`}
                  value={editForm.origin}
                  onChange={e => setEditForm(f => ({ ...f, origin: e.target.value }))}
                  placeholder="e.g. Chicago"
                  data-testid={`input-edit-origin-${item.lane.id}`}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`edit-origin-state-${item.lane.id}`}>Origin state</Label>
                <Input
                  id={`edit-origin-state-${item.lane.id}`}
                  value={editForm.originState}
                  onChange={e => setEditForm(f => ({ ...f, originState: e.target.value }))}
                  placeholder="e.g. IL"
                  maxLength={2}
                  data-testid={`input-edit-origin-state-${item.lane.id}`}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={`edit-destination-${item.lane.id}`}>Destination city</Label>
                <Input
                  id={`edit-destination-${item.lane.id}`}
                  value={editForm.destination}
                  onChange={e => setEditForm(f => ({ ...f, destination: e.target.value }))}
                  placeholder="e.g. Dallas"
                  data-testid={`input-edit-destination-${item.lane.id}`}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`edit-destination-state-${item.lane.id}`}>Destination state</Label>
                <Input
                  id={`edit-destination-state-${item.lane.id}`}
                  value={editForm.destinationState}
                  onChange={e => setEditForm(f => ({ ...f, destinationState: e.target.value }))}
                  placeholder="e.g. TX"
                  maxLength={2}
                  data-testid={`input-edit-destination-state-${item.lane.id}`}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={`edit-equipment-${item.lane.id}`}>Equipment type</Label>
                <Input
                  id={`edit-equipment-${item.lane.id}`}
                  value={editForm.equipmentType}
                  onChange={e => setEditForm(f => ({ ...f, equipmentType: e.target.value }))}
                  placeholder="e.g. Dry Van"
                  data-testid={`input-edit-equipment-${item.lane.id}`}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`edit-loads-${item.lane.id}`}>Avg loads/week</Label>
                <Input
                  id={`edit-loads-${item.lane.id}`}
                  type="number"
                  min="0"
                  step="0.1"
                  value={editForm.avgLoadsPerWeek}
                  onChange={e => setEditForm(f => ({ ...f, avgLoadsPerWeek: e.target.value }))}
                  placeholder="e.g. 3.5"
                  data-testid={`input-edit-loads-${item.lane.id}`}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`edit-company-${item.lane.id}`}>Customer name</Label>
              <Input
                id={`edit-company-${item.lane.id}`}
                value={editForm.companyName}
                onChange={e => setEditForm(f => ({ ...f, companyName: e.target.value }))}
                placeholder="e.g. Acme Corp"
                data-testid={`input-edit-company-${item.lane.id}`}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)} data-testid={`btn-edit-cancel-${item.lane.id}`}>
              Cancel
            </Button>
            <Button
              onClick={() => editMutation.mutate(editForm)}
              disabled={editMutation.isPending || !editForm.origin.trim() || !editForm.destination.trim()}
              data-testid={`btn-edit-save-${item.lane.id}`}
            >
              {editMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Customer Group ─────────────────────────────────────────────────────────────

function CustomerGroup({
  customerName,
  items,
  completionThreshold,
  onOpen,
  bucket,
  teamMembers,
  defaultExpanded,
}: {
  customerName: string;
  items: LaneItem[];
  completionThreshold: number;
  onOpen: (laneId: string) => void;
  bucket: keyof WorkQueue;
  teamMembers: TeamMember[];
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Sync when parent triggers "expand all" / "collapse all"
  useEffect(() => {
    setExpanded(defaultExpanded);
  }, [defaultExpanded]);

  const totalLoads = items.reduce((sum, i) => sum + avgLoadsNum(i.lane.avgLoadsPerWeek), 0);
  const highFreqCount = items.filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD).length;
  const hasCrmMatch = items.some(i => i.lane.companyId);

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
          {customerName}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {hasCrmMatch && (
            <Badge variant="outline" className="text-[9px] py-0 px-1 border-blue-500/30 text-blue-400 bg-blue-500/10">CRM</Badge>
          )}
          {highFreqCount > 0 && (
            <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-amber-500/50 text-amber-400 bg-amber-500/10 gap-0.5">
              <Zap className="w-2.5 h-2.5" />
              {highFreqCount} high-freq
            </Badge>
          )}
          <span className="text-[11px] text-muted-foreground">
            {totalLoads.toFixed(1)} loads/wk avg
          </span>
          <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
            {items.length} lane{items.length !== 1 ? "s" : ""}
          </Badge>
        </div>
      </button>

      {/* Lane rows — shown only when expanded */}
      {expanded && (
        <div className="flex flex-col gap-1 px-2 pb-2 pt-0 border-t border-border/50 bg-muted/10">
          {items.map(item => (
            <LaneRow
              key={item.lane.id}
              item={item}
              completionThreshold={completionThreshold}
              onOpen={onOpen}
              bucket={bucket}
              teamMembers={teamMembers}
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
  bucket,
  teamMembers,
  highFreqOnly,
}: {
  title: string;
  description: string;
  icon: React.FC<{ className?: string }>;
  iconColor: string;
  items: LaneItem[];
  completionThreshold: number;
  onOpen: (laneId: string) => void;
  bucket: keyof WorkQueue;
  teamMembers: TeamMember[];
  highFreqOnly: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [allCustomersExpanded, setAllCustomersExpanded] = useState(false);

  const visibleItems = useMemo(() => {
    const sorted = sortItems(items);
    return highFreqOnly ? sorted.filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD) : sorted;
  }, [items, highFreqOnly]);

  const hiddenCount = items.length - visibleItems.length;

  // Group items by customer — sort customers by total loads/week desc
  const customerGroups = useMemo(() => {
    const groupMap = new Map<string, LaneItem[]>();
    for (const item of visibleItems) {
      const key = item.lane.companyName?.trim() || "Unknown Customer";
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(item);
    }
    // Sort customers by total loads/week desc
    return [...groupMap.entries()]
      .map(([name, lanes]) => ({
        name,
        lanes,
        totalLoads: lanes.reduce((s, i) => s + avgLoadsNum(i.lane.avgLoadsPerWeek), 0),
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
              {highFreqOnly && hiddenCount > 0 && (
                <span className="text-[10px] text-muted-foreground/50">(+{hiddenCount} below 2/wk hidden)</span>
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
              {highFreqOnly && items.length > 0
                ? "No 2+/week lanes in this bucket."
                : "No lanes in this bucket."}
            </p>
          ) : (
            customerGroups.map(group => (
              <CustomerGroup
                key={group.name}
                customerName={group.name}
                items={group.lanes}
                completionThreshold={completionThreshold}
                onOpen={onOpen}
                bucket={bucket}
                teamMembers={teamMembers}
                defaultExpanded={allCustomersExpanded}
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
}

const EQUIPMENT_TYPES = ["Dry Van", "Reefer", "Flatbed", "Step Deck", "RGN", "Tanker", "Box Truck", "Other"];

interface FieldNormState {
  result: NormalizationResult | null;
  dismissedSuggestion: boolean;
  acceptedCandidate: string | null;
}

const EMPTY_NORM_STATE: FieldNormState = {
  result: null,
  dismissedSuggestion: false,
  acceptedCandidate: null,
};

function LocationFeedback({
  norm,
  fieldId,
  onAccept,
  onDismiss,
}: {
  norm: FieldNormState;
  fieldId: string;
  onAccept: (canonical: string, city: string, state: string) => void;
  onDismiss: () => void;
}) {
  const { result, dismissedSuggestion } = norm;
  if (!result) return null;

  if (result.status === "exact" && result.correctedFrom) {
    return (
      <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1 mt-1" data-testid={`hint-corrected-${fieldId}`}>
        <CheckCircle2 className="w-3 h-3 shrink-0" />
        Auto-formatted to <span className="font-medium">{result.canonical}</span>
      </p>
    );
  }

  if (result.status === "corrected" && !dismissedSuggestion) {
    return (
      <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1 mt-1" data-testid={`hint-corrected-${fieldId}`}>
        <CheckCircle2 className="w-3 h-3 shrink-0" />
        Corrected from <span className="italic">{result.correctedFrom}</span> → <span className="font-medium">{result.canonical}</span>
      </p>
    );
  }

  if ((result.status === "suggested") && !dismissedSuggestion) {
    return (
      <div className="flex items-center gap-1.5 mt-1 flex-wrap" data-testid={`hint-suggested-${fieldId}`}>
        <span className="text-[11px] text-amber-600 dark:text-amber-400">Did you mean?</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[11px] bg-amber-500/10 border border-amber-400/30 text-amber-600 dark:text-amber-400 rounded px-2 py-0.5 hover:bg-amber-500/20 transition-colors"
          onClick={() => result.city && result.state && onAccept(result.canonical!, result.city, result.state)}
          data-testid={`btn-accept-suggestion-${fieldId}`}
        >
          <CheckCircle2 className="w-3 h-3" />
          {result.canonical}
        </button>
        <button
          type="button"
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          onClick={onDismiss}
          data-testid={`btn-dismiss-suggestion-${fieldId}`}
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }

  if (result.status === "ambiguous" && !dismissedSuggestion && result.candidates && result.candidates.length > 0) {
    return (
      <div className="mt-1" data-testid={`hint-ambiguous-${fieldId}`}>
        <span className="text-[11px] text-amber-600 dark:text-amber-400 block mb-1">Did you mean?</span>
        <div className="flex flex-wrap gap-1">
          {result.candidates.slice(0, 4).map(c => (
            <button
              key={`${c.city}-${c.state}`}
              type="button"
              className="inline-flex items-center gap-1 text-[11px] bg-amber-500/10 border border-amber-400/30 text-amber-600 dark:text-amber-400 rounded px-2 py-0.5 hover:bg-amber-500/20 transition-colors"
              onClick={() => onAccept(`${c.city}, ${c.state}`, c.city, c.state)}
              data-testid={`btn-candidate-${fieldId}-${c.state}`}
            >
              {c.city}, {c.state}
            </button>
          ))}
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1"
            onClick={onDismiss}
            data-testid={`btn-dismiss-ambiguous-${fieldId}`}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  }

  if (result.status === "invalid") {
    const stateInvalid = result.state && result.state.length > 2;
    return (
      <p className="text-[11px] text-destructive flex items-center gap-1 mt-1" data-testid={`hint-invalid-${fieldId}`}>
        <AlertCircle className="w-3 h-3 shrink-0" />
        {stateInvalid
          ? `"${result.state}" is not a valid US state`
          : "City not recognized — double-check the spelling"}
      </p>
    );
  }

  return null;
}

function BuildLaneDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
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
  });

  const [originNorm, setOriginNorm] = useState<FieldNormState>(EMPTY_NORM_STATE);
  const [destNorm, setDestNorm] = useState<FieldNormState>(EMPTY_NORM_STATE);

  function runNormalization(city: string, state: string, setter: (s: FieldNormState) => void) {
    if (!city.trim()) {
      setter(EMPTY_NORM_STATE);
      return;
    }
    const result = resolveLaneLocationWithConfidence(city, state || undefined);
    setter({ result, dismissedSuggestion: false, acceptedCandidate: null });

    if (result.status === "exact" || result.status === "corrected") {
      if (result.city && result.state) {
        return result;
      }
    }
    return result;
  }

  function handleOriginBlur() {
    const result = runNormalization(form.origin, form.originState, setOriginNorm);
    if (result && (result.status === "exact" || result.status === "corrected") && result.city && result.state) {
      setForm(f => ({ ...f, origin: result.city!, originState: result.state! }));
    } else if (result && result.status === "corrected" && result.city && result.state) {
      setForm(f => ({ ...f, origin: result.city!, originState: result.state! }));
    }
  }

  function handleDestBlur() {
    const result = runNormalization(form.destination, form.destinationState, setDestNorm);
    if (result && (result.status === "exact" || result.status === "corrected") && result.city && result.state) {
      setForm(f => ({ ...f, destination: result.city!, destinationState: result.state! }));
    } else if (result && result.status === "corrected" && result.city && result.state) {
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

  const originHasBlockingError = originNorm.result?.status === "invalid";
  const destHasBlockingError = destNorm.result?.status === "invalid";

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
      }).then(r => r.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: "Lane created", description: "Manual lane added to the work queue." });
      onCreated();
      onClose();
      setForm({ origin: "", originState: "", destination: "", destinationState: "", equipmentType: "", avgLoadsPerWeek: "", companyName: "", notes: "" });
      setOriginNorm(EMPTY_NORM_STATE);
      setDestNorm(EMPTY_NORM_STATE);
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
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* Origin row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="build-origin" className="text-xs">Origin City <span className="text-destructive">*</span></Label>
              <Input
                id="build-origin"
                placeholder="e.g. Salt Lake City"
                value={form.origin}
                onChange={e => {
                  setForm(f => ({ ...f, origin: e.target.value }));
                  setOriginNorm(EMPTY_NORM_STATE);
                }}
                onBlur={handleOriginBlur}
                className={originHasBlockingError ? "border-destructive focus-visible:ring-destructive" : ""}
                data-testid="input-build-origin"
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
              <Input
                id="build-dest"
                placeholder="e.g. Dallas"
                value={form.destination}
                onChange={e => {
                  setForm(f => ({ ...f, destination: e.target.value }));
                  setDestNorm(EMPTY_NORM_STATE);
                }}
                onBlur={handleDestBlur}
                className={destHasBlockingError ? "border-destructive focus-visible:ring-destructive" : ""}
                data-testid="input-build-dest"
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

export default function LaneWorkQueuePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [openLaneId, setOpenLaneId] = useState<string | null>(null);
  const [highFreqOnly, setHighFreqOnly] = useState(false);
  const [customerFilter, setCustomerFilter] = useState<string>("__all__");
  const [buildLaneOpen, setBuildLaneOpen] = useState(false);

  // Auto-open a specific lane when ?laneId=... is in the URL (cross-link from Carrier Hub / My Procurement)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const lid = params.get("laneId");
    if (lid) setOpenLaneId(lid);
  }, []);

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

  const runEngineMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/recurring-lanes/run-engine", {}).then(r => r.json()),
    onSuccess: (data: { upserted?: number; total?: number; message?: string }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({
        title: `Engine complete — ${data.upserted ?? data.total ?? 0} lane${(data.upserted ?? data.total ?? 0) !== 1 ? "s" : ""} scored`,
        description: data.message ?? "Work queue refreshed.",
      });
    },
    onError: () => toast({ title: "Engine run failed", variant: "destructive" }),
  });

  const { data: queue, isLoading, refetch } = useQuery<WorkQueue>({
    queryKey: ["/api/recurring-lanes/work-queue"],
    queryFn: () => fetch("/api/recurring-lanes/work-queue").then(r => r.json()),
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

  const { data: engineStatus } = useQuery<{ meta: EngineRunMeta | null }>({
    queryKey: ["/api/recurring-lanes/engine-status"],
    queryFn: () => fetch("/api/recurring-lanes/engine-status").then(r => r.json()),
    enabled: isAdminOrDirector,
    staleTime: 60_000,
  });

  const { data: sourcingPerf = [] } = useQuery<Array<{
    sourceChannel: string;
    label: string;
    carriersImported: number;
    outreached: number;
    responded: number;
    responseRate: number;
  }>>({
    queryKey: ["/api/carriers/sourcing-performance"],
    queryFn: () => fetch("/api/carriers/sourcing-performance").then(r => r.json()),
    enabled: isAdminOrDirector,
    staleTime: 60_000,
  });

  // Helper to apply customer + high-freq filters to a bucket
  const filterBucket = (items: LaneItem[]) => {
    let out = items;
    if (customerFilter !== "__all__") {
      out = out.filter(i => i.lane.companyName === customerFilter);
    }
    if (highFreqOnly) {
      out = out.filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD);
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
  }, [queue, customerFilter, highFreqOnly]);

  // Count high-frequency lanes across all buckets for the filter chip label
  const highFreqCount = useMemo(() => {
    if (!queue?.unassigned) return 0;
    return (
      queue.unassigned.filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD).length +
      (queue.noContactable ?? []).filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD).length +
      (queue.assignedUntouched ?? []).filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD).length +
      (queue.inProgress ?? []).filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD).length
    );
  }, [queue]);

  const totalLanes = (queue?.unassigned?.length ?? 0) +
    (queue?.noContactable?.length ?? 0) +
    (queue?.assignedUntouched?.length ?? 0) +
    (queue?.inProgress?.length ?? 0);

  // Sort unassigned by avgLoadsPerWeek descending so highest-frequency lanes appear first
  const sortedUnassigned = [...(filteredQueue?.unassigned ?? [])].sort((a, b) => {
    const aVal = parseLoadsPerWeek(a.lane.avgLoadsPerWeek) ?? 0;
    const bVal = parseLoadsPerWeek(b.lane.avgLoadsPerWeek) ?? 0;
    return bVal - aVal;
  });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border px-6 py-4 flex items-center justify-between bg-card">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center">
            <ListFilter className="w-5 h-5 text-amber-500" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-foreground flex items-center gap-1.5">
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
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {/* Build Lane button */}
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
                {(queue?.customers ?? []).map(name => (
                  <SelectItem key={name} value={name}>{name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {/* 2+/week filter toggle */}
          <Button
            variant={highFreqOnly ? "default" : "outline"}
            size="sm"
            className={`h-8 text-xs gap-1.5 ${highFreqOnly ? "bg-amber-500 hover:bg-amber-600 text-white border-transparent" : ""}`}
            onClick={() => setHighFreqOnly(v => !v)}
            data-testid="btn-filter-high-freq"
          >
            <Zap className="w-3.5 h-3.5" />
            2+/week{highFreqCount > 0 && ` (${highFreqCount})`}
          </Button>
          {/* Admin-only: manually trigger the lane capacity engine */}
          {user?.role === "admin" && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
              onClick={() => runEngineMutation.mutate()}
              disabled={runEngineMutation.isPending}
              data-testid="btn-run-engine"
            >
              {runEngineMutation.isPending
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Play className="w-3.5 h-3.5" />}
              Run Engine
            </Button>
          )}
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
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-8">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading work queue…</span>
          </div>
        ) : (
          <>
            {/* Summary stat chips — reflect filtered counts */}
            {filteredQueue && (
              <div className="flex gap-3 flex-wrap mb-6">
                <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]">
                  <p className="text-lg font-bold text-orange-400">{filteredQueue.unassigned.length}</p>
                  <p className="text-[10px] text-orange-400/70">Unassigned</p>
                </div>
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]">
                  <p className="text-lg font-bold text-red-400">{filteredQueue.noContactable.length}</p>
                  <p className="text-[10px] text-red-400/70">No Contact Info</p>
                </div>
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]">
                  <p className="text-lg font-bold text-blue-400">{filteredQueue.assignedUntouched.length}</p>
                  <p className="text-[10px] text-blue-400/70">Untouched</p>
                </div>
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]">
                  <p className="text-lg font-bold text-amber-400">{filteredQueue.inProgress.length}</p>
                  <p className="text-[10px] text-amber-400/70">In Progress</p>
                </div>
                {/* High-frequency summary chip */}
                {highFreqCount > 0 && (
                  <button
                    className={`flex items-center gap-1.5 border rounded-lg px-3 py-2 text-center min-w-[80px] transition-colors ${
                      highFreqOnly
                        ? "bg-amber-500/20 border-amber-500/40"
                        : "bg-amber-500/10 border-amber-500/20 hover:border-amber-500/40"
                    }`}
                    onClick={() => setHighFreqOnly(v => !v)}
                    data-testid="btn-highfreq-chip"
                  >
                    <Zap className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <div>
                      <p className="text-lg font-bold text-amber-400 leading-none">{highFreqCount}</p>
                      <p className="text-[10px] text-amber-400/70">2+/wk</p>
                    </div>
                  </button>
                )}
              </div>
            )}

            {/* Admin engine metadata debug panel */}
            {isAdminOrDirector && engineStatus?.meta && (
              <div className="mb-5 rounded-lg border border-border bg-muted/30 px-4 py-3 flex flex-wrap gap-4 items-center" data-testid="engine-debug-panel">
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Database className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="font-medium text-foreground">Last Engine Run</span>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  Source: <span className="text-foreground">{engineStatus.meta.source}</span>
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Uploads used: <span className="text-foreground">{engineStatus.meta.uploadIds.length}</span>
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Rows scanned: <span className="text-foreground">{engineStatus.meta.rowsScanned.toLocaleString()}</span>
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Lanes generated: <span className="text-foreground">{engineStatus.meta.lanesGenerated}</span>
                </span>
                {engineStatus.meta.latestUploadDate && (
                  <span className="text-[11px] text-muted-foreground">
                    Upload date: <span className="text-foreground">
                      {new Date(engineStatus.meta.latestUploadDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </span>
                  </span>
                )}
              </div>
            )}

            {/* Sourcing Performance Panel — admin/director only */}
            {isAdminOrDirector && sourcingPerf.length > 0 && (
              <div className="mb-5 rounded-lg border border-border bg-card" data-testid="sourcing-performance-panel">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
                  <div className="w-6 h-6 rounded bg-teal-500/15 flex items-center justify-center">
                    <svg className="w-3.5 h-3.5 text-teal-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-foreground">Carrier Sourcing Performance</p>
                    <p className="text-[10px] text-muted-foreground">Response rates by channel</p>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left px-4 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Source</th>
                        <th className="text-right px-4 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Imported</th>
                        <th className="text-right px-4 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Outreached</th>
                        <th className="text-right px-4 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Responded</th>
                        <th className="text-right px-4 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Response %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sourcingPerf.map(ch => (
                        <tr key={ch.sourceChannel} className="border-b border-border/50 last:border-0 hover:bg-muted/20">
                          <td className="px-4 py-2 font-medium text-foreground">{ch.label}</td>
                          <td className="px-4 py-2 text-right text-muted-foreground">{ch.carriersImported}</td>
                          <td className="px-4 py-2 text-right text-muted-foreground">{ch.outreached}</td>
                          <td className="px-4 py-2 text-right text-emerald-500">{ch.responded}</td>
                          <td className="px-4 py-2 text-right">
                            <span className={`font-semibold ${ch.responseRate >= 40 ? "text-emerald-400" : ch.responseRate >= 20 ? "text-amber-400" : "text-muted-foreground"}`}>
                              {ch.responseRate}%
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Buckets — use filteredQueue */}
            {filteredQueue && (
              <>
                <BucketSection
                  title="Unassigned"
                  description={
                    highFreqOnly
                      ? "Showing 2+/wk lanes only — highest procurement priority."
                      : "These lanes have no owner — assign one to get outreach started. Sorted highest frequency first."
                  }
                  icon={UserX}
                  iconColor="bg-orange-500/10 text-orange-400"
                  items={sortedUnassigned}
                  completionThreshold={completionThreshold}
                  onOpen={setOpenLaneId}
                  bucket="unassigned"
                  teamMembers={teamMembers}
                  highFreqOnly={highFreqOnly}
                />
                <BucketSection
                  title="No Contactable Carriers"
                  description="Assigned but carriers have no phone or email — update the carrier catalog."
                  icon={AlertCircle}
                  iconColor="bg-red-500/10 text-red-400"
                  items={filteredQueue.noContactable}
                  completionThreshold={completionThreshold}
                  onOpen={setOpenLaneId}
                  bucket="noContactable"
                  teamMembers={teamMembers}
                  highFreqOnly={highFreqOnly}
                />
                <BucketSection
                  title="Assigned — Untouched"
                  description="Owner assigned and carriers are contactable — no outreach logged yet."
                  icon={Truck}
                  iconColor="bg-blue-500/10 text-blue-400"
                  items={filteredQueue.assignedUntouched}
                  completionThreshold={completionThreshold}
                  onOpen={setOpenLaneId}
                  bucket="assignedUntouched"
                  teamMembers={teamMembers}
                  highFreqOnly={highFreqOnly}
                />
                <BucketSection
                  title="In Progress"
                  description="Outreach started — keep going to hit the target."
                  icon={CheckCircle2}
                  iconColor="bg-amber-500/10 text-amber-400"
                  items={filteredQueue.inProgress}
                  completionThreshold={completionThreshold}
                  onOpen={setOpenLaneId}
                  bucket="inProgress"
                  teamMembers={teamMembers}
                  highFreqOnly={highFreqOnly}
                />
              </>
            )}

            {!isLoading && totalLanes === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                {user?.role === "admin" ? (
                  <>
                    <Play className="w-10 h-10 text-emerald-400 mb-3" />
                    <p className="text-sm font-semibold text-foreground">No lanes scored yet</p>
                    <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                      The lane capacity engine hasn't run against your TMS upload data in this environment.
                      Click <strong>Run Engine</strong> in the header to score lanes from your financial uploads.
                    </p>
                    <Button
                      size="sm"
                      className="mt-4 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                      onClick={() => runEngineMutation.mutate()}
                      disabled={runEngineMutation.isPending}
                      data-testid="btn-run-engine-empty"
                    >
                      {runEngineMutation.isPending
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Play className="w-3.5 h-3.5" />}
                      {runEngineMutation.isPending ? "Running…" : "Run Engine Now"}
                    </Button>
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

            {/* Admin debug panel — queue correctness at a glance */}
            {user?.role === "admin" && queue && !isLoading && (
              <details className="mt-8 border border-border rounded-lg overflow-hidden" data-testid="admin-debug-panel">
                <summary className="px-4 py-2 text-[11px] text-muted-foreground cursor-pointer select-none hover:bg-muted/40 transition-colors">
                  Admin: Queue Debug ({totalLanes} lanes across {Object.values(queue).filter(Array.isArray).filter(a => a.length > 0).length} buckets)
                </summary>
                <div className="px-4 py-3 bg-muted/20 font-mono text-[10px] leading-relaxed space-y-2">
                  {(["unassigned", "noContactable", "assignedUntouched", "inProgress"] as const).map(bucket => (
                    <div key={bucket}>
                      <span className="text-foreground font-semibold">{bucket}</span>
                      <span className="text-muted-foreground"> ({queue[bucket].length})</span>
                      {queue[bucket].length > 0 && (
                        <ul className="pl-3 mt-0.5 space-y-0.5">
                          {queue[bucket].map(item => (
                            <li key={item.lane.id} className="text-muted-foreground">
                              {item.lane.id.slice(0, 8)}… {item.lane.origin}→{item.lane.destination}
                              {" | "}{item.lane.avgLoadsPerWeek ?? "—"}/wk
                              {" | "}owner={item.lane.ownerName ?? "none"}
                              {" | "}contacted={item.lane.carriersContactedCount ?? 0}
                              {" | "}bench={item.totalBenchCount}
                              {" | "}contactable={item.contactableCount}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>

      {/* Build Lane dialog */}
      <BuildLaneDialog
        open={buildLaneOpen}
        onClose={() => setBuildLaneOpen(false)}
        onCreated={() => {}}
      />

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
    </div>
  );
}
