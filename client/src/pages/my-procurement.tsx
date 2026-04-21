/**
 * My Procurement — Personal procurement work surface for the authenticated user.
 *
 * Shows two source types in one unified view — both always open the same LWQ workspace:
 *  1. LWQ Lane Assignments  — recurring lanes where I am the owner
 *  2. Award Procurement     — carrier_procurement tasks assigned to me
 *
 * For award tasks the server resolves a `matchedLaneId` by matching origin/destination
 * against recurring_lanes, so "Open in LWQ" deep-links identically for both sources.
 */

import { useState, useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Eye, X } from "lucide-react";
import { formatLaneDisplay, normalizeEquipmentType } from "@shared/laneFormatters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Truck,
  Building2,
  CheckCircle2,
  Clock,
  Briefcase,
  ListFilter,
  ChevronRight,
  Loader2,
  RefreshCw,
  Award,
  AlertCircle,
  ExternalLink,
  MessageCircle,
  Zap,
  AlertTriangle,
  CalendarClock,
  Package,
  Send,
  UserCheck,
  ShieldCheck,
  Pencil,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ── Types ──────────────────────────────────────────────────────────────────────

interface LaneReplySummary {
  totalReplied: number;
  hotCount: number;
  topStatus: string | null;
  topCarrierName: string | null;
  needsAction: boolean;  // hot reply AND no open follow-up task yet
}

interface LwqLane {
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
  ownerUserId: string | null;
  assignedAt: string | null;
  carriersContactedCount: number;
  isManual: boolean;
  replySummary?: LaneReplySummary;
}

interface AwardTask {
  taskId: string;
  title: string;
  status: string;
  dueDate: string | null;
  companyId: string | null;
  createdAt: string | null;
  origin: string | null;
  destination: string | null;
  awardId: string | null;
  awardTitle: string | null;
  customerName: string | null;
  equipmentType: string | null;
  matchedLaneId: string | null;
}

interface TriggeredPlay {
  runId: string;
  playId: string;
  playName: string;
  channel: string;
  audience: string;
  suggestedAt: string;
  signalType: string | null;
}

interface AvailableFreightOpp {
  id: string;
  companyId: string;
  companyName: string | null;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  pickupWindowStart: string;
  pickupWindowEnd: string;
  loadCount: number;
  status: string;
  urgencyScore: number;
  ownerUserId: string | null;
  delegatedToUserId: string | null;
  approvedAt: string | null;
  approvedById: string | null;
  hasTemplateOverride: boolean;
  sourceFileName: string | null;
  isDelegatedToMe: boolean;
  needsApproval: boolean;
  isUnassigned: boolean;
}

interface MyProcurementData {
  lwqLanes: LwqLane[];
  awardTasks: AwardTask[];
  availableFreight?: AvailableFreightOpp[];
  triggeredPlays?: TriggeredPlay[];
  viewing?: { id: string; name: string; isOther: boolean } | null;
  pagination?: {
    limit: number;
    lwqNextCursor: string | null;
    tasksNextCursor: string | null;
  };
}

interface TeamMemberOption {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
}

const VIEW_OTHERS_ROLES = new Set([
  "admin",
  "director",
  "sales_director",
  "national_account_manager",
  "logistics_manager",
]);

const COMPLETION_THRESHOLD = 3;

const REPLY_STATUS_LABELS: Record<string, string> = {
  available_now: "Available Now",
  available_next_week: "Available Next Week",
  future_interest: "Future Interest",
  not_fit: "Not a Fit",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function daysAgo(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function daysUntilDue(dueDateStr: string | null): number | null {
  if (!dueDateStr) return null;
  const diff = new Date(dueDateStr).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function DueDateBadge({ dueDate }: { dueDate: string | null }) {
  if (!dueDate) return null;
  const days = daysUntilDue(dueDate);
  if (days === null) return null;
  if (days < 0) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-semibold text-red-400 border-red-800 bg-red-950/40 animate-pulse"
        data-testid="badge-overdue"
      >
        <AlertTriangle className="w-3 h-3" />
        Overdue by {Math.abs(days)}d
      </span>
    );
  }
  if (days <= 2) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-medium text-amber-400 border-amber-800 bg-amber-950/40"
        data-testid="badge-due-soon"
      >
        <CalendarClock className="w-3 h-3" />
        Due in {days}d
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-orange-400"
      data-testid="badge-due-date"
    >
      <Clock className="w-3 h-3" />
      Due {new Date(dueDate).toLocaleDateString()}
    </span>
  );
}

function AgeBadge({ dateStr, label }: { dateStr: string | null; label: string }) {
  const days = daysAgo(dateStr);
  if (days === null) return null;
  const color =
    days > 14
      ? "text-red-400 border-red-800 bg-red-950/40"
      : days > 7
      ? "text-amber-400 border-amber-800 bg-amber-950/40"
      : "text-emerald-400 border-emerald-800 bg-emerald-950/40";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-medium ${color}`}
      data-testid="badge-age"
    >
      <Clock className="w-3 h-3" />
      {label} {days}d ago
    </span>
  );
}

function ProgressPips({ contacted, threshold }: { contacted: number; threshold: number }) {
  return (
    <div className="flex items-center gap-1" data-testid="pips-contacted">
      {Array.from({ length: threshold }).map((_, i) => (
        <span
          key={i}
          className={`w-2.5 h-2.5 rounded-full border ${
            i < contacted
              ? "bg-emerald-500 border-emerald-400"
              : "bg-muted border-muted-foreground/30"
          }`}
        />
      ))}
      <span className="text-xs text-muted-foreground ml-1">
        {contacted}/{threshold} contacted
      </span>
    </div>
  );
}

/** Shared primary action button — same visual treatment for both sources */
function OpenInLwqButton({
  laneId,
  testId,
  disabled,
}: {
  laneId: string;
  testId: string;
  disabled?: boolean;
}) {
  const [, navigate] = useLocation();
  return (
    <Button
      size="sm"
      variant="default"
      className="h-8 text-xs gap-1.5"
      data-testid={testId}
      disabled={disabled}
      onClick={() => navigate(`/lanes/work-queue?laneId=${laneId}`)}
    >
      <ListFilter className="w-3.5 h-3.5" />
      Open in LWQ
      <ChevronRight className="w-3 h-3" />
    </Button>
  );
}

// ── LWQ Lane Card ──────────────────────────────────────────────────────────────

function LwqLaneCard({ item, onResolve, readOnly }: { item: LwqLane; onResolve: (id: string) => void; readOnly?: boolean }) {
  const contacted = item.carriersContactedCount ?? 0;
  const laneDisplay = formatLaneDisplay(
    item.origin,
    item.originState,
    item.destination,
    item.destinationState
  );
  const equip = item.equipmentType ? normalizeEquipmentType(item.equipmentType) : "—";
  const avgLoads = item.avgLoadsPerWeek
    ? `~${parseFloat(item.avgLoadsPerWeek).toFixed(1)} loads/wk`
    : null;
  const reply = item.replySummary;
  const hasHotReply = (reply?.hotCount ?? 0) > 0;
  const needsAction = reply?.needsAction ?? false;

  // Prefetch lane detail on hover so CarrierOutreachPanel opens instantly
  function handleMouseEnter() {
    queryClient.prefetchQuery({
      queryKey: ["/api/recurring-lanes", item.laneId, "detail"],
      queryFn: () => fetch(`/api/recurring-lanes/${item.laneId}/detail`).then(r => r.json()),
      staleTime: 2 * 60 * 1000,
    });
  }

  return (
    <div
      className={`flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-lg border bg-card hover:bg-accent/5 transition-colors ${
        needsAction ? "border-green-500/40 bg-green-950/5" : ""
      }`}
      onMouseEnter={handleMouseEnter}
      data-testid={`card-lwq-lane-${item.laneId}`}
    >
      {/* Source badge */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge
            variant="outline"
            className="text-xs border-blue-700 text-blue-400 bg-blue-950/30 shrink-0"
            data-testid={`badge-source-lwq-${item.laneId}`}
          >
            <Truck className="w-2.5 h-2.5 mr-1" />
            LWQ
          </Badge>
          <span className="font-semibold text-sm truncate" data-testid={`text-lane-${item.laneId}`}>
            {laneDisplay}
          </span>
          {item.isManual && (
            <Badge variant="outline" className="text-xs border-slate-600 text-slate-400">
              Manual
            </Badge>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {item.companyName && (
            <span className="flex items-center gap-1">
              <Building2 className="w-3 h-3" />
              {item.companyName}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Truck className="w-3 h-3" />
            {equip}
          </span>
          {avgLoads && <span>{avgLoads}</span>}
          <AgeBadge dateStr={item.assignedAt} label="Assigned" />
          {reply && reply.totalReplied > 0 && (
            hasHotReply ? (
              <span
                className={`flex items-center gap-1 font-medium ${needsAction ? "text-green-400" : "text-green-600"}`}
                data-testid={needsAction ? `text-reply-needs-action-${item.laneId}` : `text-reply-hot-${item.laneId}`}
                title={reply.topCarrierName ? `${reply.topCarrierName}: ${REPLY_STATUS_LABELS[reply.topStatus ?? ""] ?? reply.topStatus}` : undefined}
              >
                {needsAction ? <Zap className="w-3 h-3" /> : <MessageCircle className="w-3 h-3" />}
                {needsAction ? "Needs Action — " : ""}{reply.hotCount} available
                {needsAction && <span className="text-[10px] font-normal opacity-80 ml-0.5">(no task yet)</span>}
              </span>
            ) : (
              <span
                className="flex items-center gap-1 text-slate-400"
                data-testid={`text-reply-${item.laneId}`}
              >
                <MessageCircle className="w-3 h-3" />
                {reply.totalReplied} replied
              </span>
            )
          )}
        </div>
        <div className="mt-2">
          <ProgressPips contacted={contacted} threshold={COMPLETION_THRESHOLD} />
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 shrink-0">
        <OpenInLwqButton laneId={item.laneId} testId={`btn-open-lwq-${item.laneId}`} />
        {!readOnly && contacted >= COMPLETION_THRESHOLD && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs gap-1.5 border-emerald-700 text-emerald-400 hover:bg-emerald-950/30"
            data-testid={`btn-resolve-lane-${item.laneId}`}
            onClick={() => onResolve(item.laneId)}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            Mark Done
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Award Task Card ────────────────────────────────────────────────────────────

function AwardTaskCard({ item, onClose, readOnly }: { item: AwardTask; onClose: (id: string) => void; readOnly?: boolean }) {
  const [, navigate] = useLocation();
  const laneDisplay =
    item.origin && item.destination
      ? formatLaneDisplay(item.origin, null, item.destination, null)
      : "Unknown lane";

  // Primary action: open LWQ at the matched lane.
  // If no match found, go to LWQ root with a ?noMatch= hint so the rep gets a toast
  // describing the lane they were looking for.
  const noMatchHint = item.origin && item.destination
    ? encodeURIComponent(`${item.origin} → ${item.destination}`)
    : null;
  const primaryDestination = item.matchedLaneId
    ? `/lanes/work-queue?laneId=${item.matchedLaneId}`
    : `/lanes/work-queue${noMatchHint ? `?noMatch=${noMatchHint}` : ""}`;

  const daysLeft = daysUntilDue(item.dueDate);
  const isOverdue = daysLeft !== null && daysLeft < 0;
  const isDueSoon = daysLeft !== null && daysLeft >= 0 && daysLeft <= 2;

  return (
    <div
      className={`flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-lg border bg-card hover:bg-accent/5 transition-colors ${
        isOverdue ? "border-red-600/50 bg-red-950/5" : isDueSoon ? "border-amber-600/50 bg-amber-950/5" : ""
      }`}
      data-testid={`card-award-task-${item.taskId}`}
    >
      {/* Lane identity */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge
            variant="outline"
            className="text-xs border-amber-700 text-amber-400 bg-amber-950/30 shrink-0"
            data-testid={`badge-source-award-${item.taskId}`}
          >
            <Award className="w-2.5 h-2.5 mr-1" />
            Award
          </Badge>
          <span
            className="font-semibold text-sm truncate"
            data-testid={`text-lane-award-${item.taskId}`}
          >
            {laneDisplay}
          </span>
          {item.awardTitle && (
            <span className="text-xs text-muted-foreground truncate">
              {item.awardTitle}
            </span>
          )}
          {/* Indicate when no matching LWQ lane was found — so the rep knows context */}
          {!item.matchedLaneId && (
            <Badge
              variant="outline"
              className="text-xs border-slate-600 text-slate-500"
              title="No matching lane found in the work queue — you'll land on the LWQ home"
            >
              No lane match
            </Badge>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {item.customerName && (
            <span className="flex items-center gap-1">
              <Building2 className="w-3 h-3" />
              {item.customerName}
            </span>
          )}
          {item.equipmentType && (
            <span className="flex items-center gap-1">
              <Truck className="w-3 h-3" />
              {normalizeEquipmentType(item.equipmentType)}
            </span>
          )}
          <AgeBadge dateStr={item.createdAt} label="Created" />
          <DueDateBadge dueDate={item.dueDate} />
        </div>
      </div>

      {/* Actions — primary is always LWQ; award link is secondary */}
      <div className="flex items-center gap-2 shrink-0">
        <Button
          size="sm"
          variant="default"
          className="h-8 text-xs gap-1.5"
          data-testid={`btn-open-lwq-award-${item.taskId}`}
          onClick={() => navigate(primaryDestination)}
        >
          <ListFilter className="w-3.5 h-3.5" />
          Open in LWQ
          <ChevronRight className="w-3 h-3" />
        </Button>
        {/* Secondary: View Award for reference/context */}
        {item.awardId && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs gap-1 text-muted-foreground hover:text-foreground"
            data-testid={`btn-view-award-${item.taskId}`}
            onClick={() => navigate(`/rfp-awards?awardId=${item.awardId}&tab=lanes`)}
          >
            <ExternalLink className="w-3 h-3" />
            Award
          </Button>
        )}
        {!readOnly && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs gap-1.5 border-emerald-700 text-emerald-400 hover:bg-emerald-950/30"
            data-testid={`btn-close-task-${item.taskId}`}
            onClick={() => onClose(item.taskId)}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            Mark Done
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function MyProcurementPage() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const search = useSearch();
  const { user: currentUser } = useAuth();
  const [activeTab, setActiveTab] = useState<"all" | "lwq" | "award" | "available-freight">("all");

  const canViewOthers = !!currentUser && VIEW_OTHERS_ROLES.has(currentUser.role);
  const viewingUserId = useMemo(() => {
    const params = new URLSearchParams(search || "");
    return params.get("userId");
  }, [search]);
  const isViewingOther = canViewOthers && !!viewingUserId && viewingUserId !== currentUser?.id;

  const procurementUrl = isViewingOther
    ? `/api/my-procurement?userId=${encodeURIComponent(viewingUserId!)}`
    : "/api/my-procurement";

  const procurementQueryKey = ["/api/my-procurement", viewingUserId ?? null] as const;

  const { data, isLoading, isError, refetch, isFetching } = useQuery<MyProcurementData>({
    queryKey: procurementQueryKey,
    queryFn: () => fetch(procurementUrl, { credentials: "include" }).then((r) => {
      if (!r.ok) throw new Error("Failed to load procurement data");
      return r.json();
    }),
    staleTime: 60_000,
    refetchInterval: 90_000,
  });

  const teamMembersQ = useQuery<TeamMemberOption[]>({
    queryKey: ["/api/users", { includeManagers: true }],
    queryFn: () =>
      fetch("/api/users?includeManagers=true", { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error("Failed to load team members");
        return r.json();
      }),
    enabled: canViewOthers,
    staleTime: 5 * 60_000,
  });

  function setViewing(userId: string | null) {
    const params = new URLSearchParams(search || "");
    if (userId) params.set("userId", userId);
    else params.delete("userId");
    const qs = params.toString();
    navigate(`/my-procurement${qs ? `?${qs}` : ""}`);
  }

  const resolveMutation = useMutation({
    mutationFn: (laneId: string) =>
      apiRequest("POST", `/api/my-procurement/lwq-lane/${laneId}/resolve`).then((r) => r.json()),
    onMutate: async (laneId: string) => {
      await queryClient.cancelQueries({ queryKey: procurementQueryKey });
      const previous = queryClient.getQueryData<MyProcurementData>(procurementQueryKey);
      queryClient.setQueryData<MyProcurementData>(procurementQueryKey, (old) => {
        if (!old) return old;
        return { ...old, lwqLanes: old.lwqLanes.filter((l) => l.laneId !== laneId) };
      });
      return { previous };
    },
    onSuccess: () => {
      toast({ title: "Lane marked as done" });
    },
    onError: (_err, _laneId, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(procurementQueryKey, ctx.previous);
      toast({ title: "Failed to mark done", variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: procurementQueryKey });
    },
  });

  const closeMutation = useMutation({
    mutationFn: (taskId: string) =>
      apiRequest("POST", `/api/my-procurement/award-task/${taskId}/close`).then((r) => r.json()),
    onMutate: async (taskId: string) => {
      await queryClient.cancelQueries({ queryKey: procurementQueryKey });
      const previous = queryClient.getQueryData<MyProcurementData>(procurementQueryKey);
      queryClient.setQueryData<MyProcurementData>(procurementQueryKey, (old) => {
        if (!old) return old;
        return { ...old, awardTasks: old.awardTasks.filter((t) => t.taskId !== taskId) };
      });
      return { previous };
    },
    onSuccess: () => {
      toast({ title: "Task closed" });
    },
    onError: (_err, _taskId, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(procurementQueryKey, ctx.previous);
      toast({ title: "Failed to close task", variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: procurementQueryKey });
    },
  });

  const lwqLanes = data?.lwqLanes ?? [];
  const awardTasks = data?.awardTasks ?? [];
  const availableFreight = data?.availableFreight ?? [];
  const availableFreightPending = availableFreight.filter(
    (o) => o.status === "ready_to_send" || o.status === "new",
  ).length;
  const total = lwqLanes.length + awardTasks.length + availableFreight.length;
  const inProgress = lwqLanes.filter((l) => l.carriersContactedCount > 0).length;
  const matchedCount = awardTasks.filter((t) => t.matchedLaneId).length;

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header */}
      <div className="border-b px-4 md:px-6 py-3 md:py-4 bg-card shrink-0">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h1 className="text-lg md:text-xl font-semibold flex items-center gap-2">
              <Briefcase className="w-5 h-5 text-primary" />
              {isViewingOther && data?.viewing
                ? `Procurement — ${data.viewing.name}`
                : "My Procurement"}
            </h1>
            <p className="text-xs md:text-sm text-muted-foreground mt-0.5">
              {isViewingOther
                ? "Read-only view of another rep's procurement queue"
                : "All your active procurement work in one place"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {canViewOthers && (
              <div className="flex items-center gap-2" data-testid="rep-picker-wrapper">
                <Eye className="w-4 h-4 text-muted-foreground" />
                <Select
                  value={viewingUserId ?? "__self__"}
                  onValueChange={(v) => setViewing(v === "__self__" ? null : v)}
                >
                  <SelectTrigger className="h-8 w-[220px]" data-testid="select-view-rep">
                    <SelectValue placeholder="Viewing my queue" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__self__" data-testid="option-rep-self">
                      My queue ({currentUser?.name ?? "me"})
                    </SelectItem>
                    {(teamMembersQ.data ?? [])
                      .filter((u) => u.id !== currentUser?.id)
                      .sort((a, b) =>
                        (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "")
                      )
                      .map((u) => (
                        <SelectItem
                          key={u.id}
                          value={u.id}
                          data-testid={`option-rep-${u.id}`}
                        >
                          {u.name ?? u.email ?? u.id}
                          {u.role ? ` · ${u.role}` : ""}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {isViewingOther && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2"
                    onClick={() => setViewing(null)}
                    data-testid="btn-clear-view-rep"
                  >
                    <X className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            )}
            {/* Summary stats */}
            <div className="flex items-center gap-4 text-sm">
              <div className="text-center" data-testid="stat-total">
                <div className="font-semibold text-lg leading-none">{total}</div>
                <div className="text-muted-foreground text-xs">Total</div>
              </div>
              <div className="text-center" data-testid="stat-lwq">
                <div className="font-semibold text-lg leading-none">{lwqLanes.length}</div>
                <div className="text-muted-foreground text-xs">LWQ</div>
              </div>
              <div className="text-center" data-testid="stat-award">
                <div className="font-semibold text-lg leading-none">{awardTasks.length}</div>
                <div className="text-muted-foreground text-xs">Award</div>
              </div>
              <div className="text-center" data-testid="stat-in-progress">
                <div className="font-semibold text-lg leading-none text-emerald-400">{inProgress}</div>
                <div className="text-muted-foreground text-xs">In Progress</div>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="btn-refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 px-4 md:px-6 py-4">
        {isLoading ? (
          <div className="space-y-3 py-4" data-testid="procurement-skeleton">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex gap-3 items-center p-4 rounded-lg border border-border bg-card">
                <div className="flex-1 space-y-2">
                  <div className="flex gap-2 items-center">
                    <Skeleton className="h-5 w-12 rounded" />
                    <Skeleton className="h-4 w-40" />
                  </div>
                  <div className="flex gap-2">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                </div>
                <Skeleton className="h-8 w-24 shrink-0" />
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className="flex items-center justify-center py-20 text-destructive gap-2">
            <AlertCircle className="w-5 h-5" />
            Failed to load procurement data. Try refreshing.
          </div>
        ) : total === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3 text-center text-muted-foreground">
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
            <p className="text-lg font-medium">All clear!</p>
            <p className="text-sm">
              You have no active lane assignments or procurement tasks right now.
            </p>
          </div>
        ) : (
          <>
          {(data?.triggeredPlays?.length ?? 0) > 0 && (
            <div className="mb-4 rounded-md border border-border/60 bg-card/40 p-3" data-testid="section-triggered-plays">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  Triggered Plays
                  <span className="text-xs text-muted-foreground">({data?.triggeredPlays?.length})</span>
                </h2>
                <Button variant="ghost" size="sm" onClick={() => navigate("/playbook")} data-testid="link-open-playbook">
                  Open Playbook <ExternalLink className="w-3 h-3 ml-1" />
                </Button>
              </div>
              <div className="space-y-1.5">
                {(data?.triggeredPlays ?? []).slice(0, 5).map((tp) => (
                  <div
                    key={tp.runId}
                    className="flex items-center justify-between text-sm py-1.5 px-2 rounded hover-elevate"
                    data-testid={`triggered-play-${tp.runId}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium truncate">{tp.playName}</span>
                      <span className="text-xs text-muted-foreground">{tp.channel} · {tp.audience}</span>
                      {tp.signalType && (
                        <span className="text-xs text-muted-foreground">· {tp.signalType}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 ml-3">
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(tp.suggestedAt).toLocaleDateString()}
                      </span>
                      <Button
                        size="sm"
                        variant="default"
                        className="h-7 px-2"
                        data-testid={`button-run-triggered-${tp.runId}`}
                        onClick={async () => {
                          try {
                            const resp = await apiRequest("POST", `/api/playbook/plays/${tp.playId}/run`, { suggestedRunId: tp.runId });
                            const data = await resp.json();
                            queryClient.invalidateQueries({ queryKey: ["/api/my-procurement"] });
                            queryClient.invalidateQueries({ queryKey: ["/api/playbook/runs"] });
                            const action = data?.nextAction;
                            if (action?.type === "compose_email") {
                              try { navigator.clipboard?.writeText(action.body); } catch {}
                              toast({ title: "Play started — email body copied", description: "Paste into compose to send." });
                            } else if (action?.type === "open_task") {
                              toast({ title: "Play started — task created", description: "Find it in your Tasks list." });
                            } else {
                              toast({ title: "Play started" });
                            }
                          } catch (e) {
                            toast({ title: "Failed to start play", variant: "destructive" });
                          }
                        }}
                      >
                        Run
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
            <TabsList className="mb-4" data-testid="tabs-procurement">
              <TabsTrigger value="all" data-testid="tab-all">
                All ({total})
              </TabsTrigger>
              <TabsTrigger value="lwq" data-testid="tab-lwq">
                <Truck className="w-3.5 h-3.5 mr-1.5" />
                Lane Assignments ({lwqLanes.length})
              </TabsTrigger>
              <TabsTrigger value="award" data-testid="tab-award">
                <Award className="w-3.5 h-3.5 mr-1.5" />
                Award Tasks ({awardTasks.length})
                {matchedCount > 0 && matchedCount < awardTasks.length && (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {matchedCount} matched
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="available-freight" data-testid="tab-available-freight">
                <Package className="w-3.5 h-3.5 mr-1.5" />
                Available Freight ({availableFreight.length})
                {availableFreightPending > 0 && (
                  <span
                    className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold bg-primary text-primary-foreground"
                    data-testid="badge-available-freight-pending"
                  >
                    {availableFreightPending}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            {/* All tab */}
            <TabsContent value="all">
              <div className="space-y-2">
                {lwqLanes.map((lane) => (
                  <LwqLaneCard
                    key={lane.laneId}
                    item={lane}
                    onResolve={(id) => resolveMutation.mutate(id)}
                    readOnly={isViewingOther}
                  />
                ))}
                {awardTasks.map((task) => (
                  <AwardTaskCard
                    key={task.taskId}
                    item={task}
                    onClose={(id) => closeMutation.mutate(id)}
                    readOnly={isViewingOther}
                  />
                ))}
              </div>
            </TabsContent>

            {/* LWQ tab */}
            <TabsContent value="lwq">
              {lwqLanes.length === 0 ? (
                <EmptyState message="No active lane assignments." />
              ) : (
                <div className="space-y-2">
                  {lwqLanes.map((lane) => (
                    <LwqLaneCard
                      key={lane.laneId}
                      item={lane}
                      onResolve={(id) => resolveMutation.mutate(id)}
                      readOnly={isViewingOther}
                    />
                  ))}
                </div>
              )}
            </TabsContent>

            {/* Available Freight tab */}
            <TabsContent value="available-freight">
              <AvailableFreightPanel
                items={availableFreight}
                isManager={!!currentUser && VIEW_OTHERS_ROLES.has(currentUser.role)}
                currentUserId={currentUser?.id ?? null}
                isViewingOther={isViewingOther}
                queryKey={procurementQueryKey}
              />
            </TabsContent>

            {/* Award tab */}
            <TabsContent value="award">
              {awardTasks.length === 0 ? (
                <EmptyState message="No active award procurement tasks." />
              ) : (
                <div className="space-y-2">
                  {awardTasks.map((task) => (
                    <AwardTaskCard
                      key={task.taskId}
                      item={task}
                      onClose={(id) => closeMutation.mutate(id)}
                      readOnly={isViewingOther}
                    />
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
          </>
        )}
      </div>
    </div>
  );
}

// ── Available Freight Panel + Card (task #354) ──────────────────────────────

function AvailableFreightPanel({
  items,
  isManager,
  currentUserId,
  isViewingOther,
  queryKey,
}: {
  items: AvailableFreightOpp[];
  isManager: boolean;
  currentUserId: string | null;
  isViewingOther: boolean;
  queryKey: readonly unknown[];
}) {
  const { toast } = useToast();
  const [filter, setFilter] = useState<"all" | "awaiting-approval" | "approved" | "unassigned">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const refreshMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/available-freight/import", {}).then((r) => r.json()),
    onSuccess: (resp: { summary?: { inserted: number; updated: number; expired: number } }) => {
      const s = resp.summary;
      toast({
        title: "Import complete",
        description: s ? `${s.inserted} new, ${s.updated} updated, ${s.expired} expired` : undefined,
      });
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast({ title: "Refresh failed", description: err.message, variant: "destructive" }),
  });

  const bulkApproveMutation = useMutation({
    mutationFn: (ids: string[]) =>
      apiRequest("POST", "/api/my-procurement/freight-opp/bulk-approve", {
        opportunityIds: ids,
      }).then((r) => r.json()),
    onSuccess: (resp: { approved: string[] }) => {
      toast({ title: `Approved ${resp.approved.length} opportunities` });
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast({ title: "Bulk approve failed", description: err.message, variant: "destructive" }),
  });

  const visible = useMemo(() => {
    if (filter === "awaiting-approval") return items.filter((o) => !o.approvedAt);
    if (filter === "approved") return items.filter((o) => !!o.approvedAt);
    if (filter === "unassigned") return items.filter((o) => o.isUnassigned);
    return items;
  }, [items, filter]);

  const awaitingCount = items.filter((o) => !o.approvedAt).length;
  const unassignedCount = items.filter((o) => o.isUnassigned).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={filter === "all" ? "default" : "outline"}
          onClick={() => setFilter("all")}
          data-testid="filter-af-all"
        >
          All ({items.length})
        </Button>
        {isManager && (
          <Button
            size="sm"
            variant={filter === "awaiting-approval" ? "default" : "outline"}
            onClick={() => setFilter("awaiting-approval")}
            data-testid="filter-af-awaiting"
          >
            Awaiting my approval ({awaitingCount})
          </Button>
        )}
        {isManager && (
          <Button
            size="sm"
            variant={filter === "unassigned" ? "default" : "outline"}
            onClick={() => setFilter("unassigned")}
            data-testid="filter-af-unassigned"
            className={unassignedCount > 0 && filter !== "unassigned" ? "border-amber-500/60 text-amber-400" : ""}
          >
            Unassigned ({unassignedCount})
          </Button>
        )}
        <Button
          size="sm"
          variant={filter === "approved" ? "default" : "outline"}
          onClick={() => setFilter("approved")}
          data-testid="filter-af-approved"
        >
          Approved
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {isManager && filter === "awaiting-approval" && selected.size > 0 && (
            <Button
              size="sm"
              onClick={() => bulkApproveMutation.mutate(Array.from(selected))}
              disabled={bulkApproveMutation.isPending}
              data-testid="button-bulk-approve"
            >
              {bulkApproveMutation.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />
              Approve {selected.size} selected
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            data-testid="button-refresh-import"
          >
            {refreshMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          message={
            filter === "awaiting-approval"
              ? "Nothing awaiting your approval right now."
              : "No available freight assigned to you. Imports run from the daily OneDrive spreadsheet."
          }
        />
      ) : (
        <div className="space-y-2">
          {visible.map((opp) => (
            <AvailableFreightCard
              key={opp.id}
              item={opp}
              isManager={isManager}
              currentUserId={currentUserId}
              isViewingOther={isViewingOther}
              showSelect={isManager && filter === "awaiting-approval"}
              selected={selected.has(opp.id)}
              onSelectChange={(checked) => {
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (checked) next.add(opp.id);
                  else next.delete(opp.id);
                  return next;
                });
              }}
              queryKey={queryKey}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AvailableFreightCard({
  item,
  isManager,
  currentUserId,
  isViewingOther,
  showSelect,
  selected,
  onSelectChange,
  queryKey,
}: {
  item: AvailableFreightOpp;
  isManager: boolean;
  currentUserId: string | null;
  isViewingOther: boolean;
  showSelect?: boolean;
  selected?: boolean;
  onSelectChange?: (checked: boolean) => void;
  queryKey: readonly unknown[];
}) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [editorOpen, setEditorOpen] = useState(false);
  const [delegateOpen, setDelegateOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [delegateUserId, setDelegateUserId] = useState<string>("");
  const [assignUserId, setAssignUserId] = useState<string>("");

  // Managers can act on any opportunity in their org, including when viewing
  // another rep. Reps can only act on their own (owner or current delegate).
  const isOwnerOrDelegate =
    item.ownerUserId === currentUserId || item.delegatedToUserId === currentUserId;
  const canManagerAct = isManager;
  const canRepAct = !isViewingOther && isOwnerOrDelegate;
  const canActOnIt = canManagerAct || canRepAct;

  const teamMembersQuery = useQuery<TeamMemberOption[]>({
    queryKey: ["/api/team-members"],
    enabled: delegateOpen || assignOpen,
  });

  const approveMutation = useMutation({
    mutationFn: (approve: boolean) =>
      apiRequest("POST", `/api/my-procurement/freight-opp/${item.id}/approve`, { approve }).then((r) => r.json()),
    onSuccess: () => {
      toast({ title: "Approval updated" });
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast({ title: "Approval failed", description: err.message, variant: "destructive" }),
  });

  const delegateMutation = useMutation({
    mutationFn: (userId: string | null) =>
      apiRequest("POST", `/api/my-procurement/freight-opp/${item.id}/delegate`, {
        delegatedToUserId: userId,
      }).then((r) => r.json()),
    onSuccess: () => {
      toast({ title: "Delegation updated" });
      setDelegateOpen(false);
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast({ title: "Delegate failed", description: err.message, variant: "destructive" }),
  });

  const assignMutation = useMutation({
    mutationFn: (userId: string) =>
      apiRequest("POST", `/api/my-procurement/freight-opp/${item.id}/assign`, {
        ownerUserId: userId,
      }).then((r) => r.json()),
    onSuccess: () => {
      toast({ title: "Assigned to rep" });
      setAssignOpen(false);
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast({ title: "Assign failed", description: err.message, variant: "destructive" }),
  });

  const overrideMutation = useMutation({
    mutationFn: () =>
      apiRequest("PATCH", `/api/my-procurement/freight-opp/${item.id}/template-override`, {
        subject: subject.trim() ? subject : null,
        body: body.trim() ? body : null,
      }).then((r) => r.json()),
    onSuccess: () => {
      toast({ title: "Template saved for this opportunity" });
      setEditorOpen(false);
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const lane = `${item.origin}${item.originState ? ", " + item.originState : ""} → ${item.destination}${item.destinationState ? ", " + item.destinationState : ""}`;
  const isApproved = !!item.approvedAt;

  return (
    <Card data-testid={`card-available-freight-${item.id}`} className="hover-elevate">
      <div className="p-3 md:p-4 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex items-start gap-2">
            {showSelect && (
              <input
                type="checkbox"
                className="mt-1.5"
                checked={!!selected}
                onChange={(e) => onSelectChange?.(e.target.checked)}
                data-testid={`checkbox-select-${item.id}`}
              />
            )}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Package className="w-4 h-4 text-primary shrink-0" />
              <span className="font-medium" data-testid={`text-customer-${item.id}`}>
                {item.companyName ?? "Unknown customer"}
              </span>
              {item.isDelegatedToMe && (
                <Badge variant="secondary" className="text-[10px]">Delegated to you</Badge>
              )}
              {item.isUnassigned && (
                <Badge variant="outline" className="text-[10px] border-amber-500/60 text-amber-400" data-testid={`badge-unassigned-${item.id}`}>
                  Unassigned
                </Badge>
              )}
              {item.hasTemplateOverride && (
                <Badge variant="outline" className="text-[10px]">Custom template</Badge>
              )}
              {isApproved ? (
                <Badge className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                  <ShieldCheck className="w-3 h-3 mr-1" /> Approved
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300">
                  Awaiting approval
                </Badge>
              )}
            </div>
            <div className="text-sm text-muted-foreground mt-1" data-testid={`text-lane-${item.id}`}>
              {lane}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3">
              <span>{item.equipmentType ?? "Any equipment"}</span>
              <span>
                Pickup {item.pickupWindowStart}
                {item.pickupWindowEnd !== item.pickupWindowStart ? ` – ${item.pickupWindowEnd}` : ""}
              </span>
              <span>{item.loadCount} load{item.loadCount === 1 ? "" : "s"}</span>
              {item.sourceFileName && <span className="opacity-70">{item.sourceFileName}</span>}
            </div>
          </div>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate(`/available-freight/${item.id}`)}
              data-testid={`button-open-${item.id}`}
            >
              <ExternalLink className="w-3.5 h-3.5 mr-1.5" /> Open
            </Button>
            {canActOnIt && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setSubject("");
                  setBody("");
                  setEditorOpen(true);
                }}
                data-testid={`button-edit-template-${item.id}`}
              >
                <Pencil className="w-3.5 h-3.5 mr-1.5" /> Template
              </Button>
            )}
            {canActOnIt && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDelegateOpen(true)}
                data-testid={`button-delegate-${item.id}`}
              >
                <UserCheck className="w-3.5 h-3.5 mr-1.5" /> Delegate
              </Button>
            )}
            {isManager && item.isUnassigned && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setAssignUserId("");
                  setAssignOpen(true);
                }}
                data-testid={`button-assign-${item.id}`}
                className="border-amber-500/60 text-amber-400 hover:bg-amber-950/30"
              >
                <UserCheck className="w-3.5 h-3.5 mr-1.5" /> Assign
              </Button>
            )}
            {isManager && !isApproved && (
              <Button
                size="sm"
                onClick={() => approveMutation.mutate(true)}
                disabled={approveMutation.isPending}
                data-testid={`button-approve-${item.id}`}
              >
                {approveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />}
                Approve
              </Button>
            )}
            {isManager && isApproved && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => approveMutation.mutate(false)}
                disabled={approveMutation.isPending}
                data-testid={`button-revoke-${item.id}`}
              >
                Revoke
              </Button>
            )}
            {canActOnIt && isApproved && (
              <Button
                size="sm"
                onClick={() => navigate(`/available-freight/${item.id}?action=send`)}
                data-testid={`button-send-${item.id}`}
              >
                <Send className="w-3.5 h-3.5 mr-1.5" /> Send
              </Button>
            )}
          </div>
        </div>
      </div>

      {editorOpen && (
        <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
          <DialogContent data-testid={`dialog-edit-template-${item.id}`}>
            <DialogHeader>
              <DialogTitle>Customize template for this opportunity</DialogTitle>
              <DialogDescription>
                Leave a field blank to fall back to the org default. Each edit is audited.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium">Subject override</label>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="(use default subject)"
                  data-testid={`input-subject-${item.id}`}
                />
              </div>
              <div>
                <label className="text-xs font-medium">Body override</label>
                <Textarea
                  rows={8}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="(use default body)"
                  data-testid={`input-body-${item.id}`}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditorOpen(false)}>Cancel</Button>
              <Button
                onClick={() => overrideMutation.mutate()}
                disabled={overrideMutation.isPending}
                data-testid={`button-save-template-${item.id}`}
              >
                {overrideMutation.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {assignOpen && (
        <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
          <DialogContent data-testid={`dialog-assign-${item.id}`}>
            <DialogHeader>
              <DialogTitle>Assign this freight to a rep</DialogTitle>
              <DialogDescription>
                This row came in from the daily import without an owner. The selected rep becomes the owner; any existing delegate is cleared.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <Select value={assignUserId} onValueChange={setAssignUserId}>
                <SelectTrigger data-testid={`select-assign-user-${item.id}`}>
                  <SelectValue placeholder="Choose a rep" />
                </SelectTrigger>
                <SelectContent>
                  {(teamMembersQuery.data ?? []).map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name ?? m.email ?? m.id}
                      {m.role ? ` · ${m.role}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAssignOpen(false)}>Cancel</Button>
              <Button
                onClick={() => assignUserId && assignMutation.mutate(assignUserId)}
                disabled={!assignUserId || assignMutation.isPending}
                data-testid={`button-confirm-assign-${item.id}`}
              >
                {assignMutation.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                Assign
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {delegateOpen && (
        <Dialog open={delegateOpen} onOpenChange={setDelegateOpen}>
          <DialogContent data-testid={`dialog-delegate-${item.id}`}>
            <DialogHeader>
              <DialogTitle>Delegate this opportunity</DialogTitle>
              <DialogDescription>The selected rep will own follow-up and outreach.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <Select value={delegateUserId} onValueChange={setDelegateUserId}>
                <SelectTrigger data-testid={`select-delegate-user-${item.id}`}>
                  <SelectValue placeholder="Choose a teammate" />
                </SelectTrigger>
                <SelectContent>
                  {(teamMembersQuery.data ?? []).map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name ?? m.email ?? m.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              {item.delegatedToUserId && (
                <Button
                  variant="outline"
                  onClick={() => delegateMutation.mutate(null)}
                  disabled={delegateMutation.isPending}
                  data-testid={`button-clear-delegate-${item.id}`}
                >
                  Clear delegation
                </Button>
              )}
              <Button variant="outline" onClick={() => setDelegateOpen(false)}>Cancel</Button>
              <Button
                onClick={() => delegateUserId && delegateMutation.mutate(delegateUserId)}
                disabled={!delegateUserId || delegateMutation.isPending}
                data-testid={`button-confirm-delegate-${item.id}`}
              >
                {delegateMutation.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                Delegate
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground text-sm">
      <CheckCircle2 className="w-7 h-7 text-emerald-500" />
      {message}
    </div>
  );
}
