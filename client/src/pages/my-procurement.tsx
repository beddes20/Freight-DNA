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

import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { formatLaneDisplay, normalizeEquipmentType } from "@shared/laneFormatters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

interface MyProcurementData {
  lwqLanes: LwqLane[];
  awardTasks: AwardTask[];
  pagination?: {
    limit: number;
    lwqNextCursor: string | null;
    tasksNextCursor: string | null;
  };
}

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

function LwqLaneCard({ item, onResolve }: { item: LwqLane; onResolve: (id: string) => void }) {
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
        {contacted >= COMPLETION_THRESHOLD && (
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

function AwardTaskCard({ item, onClose }: { item: AwardTask; onClose: (id: string) => void }) {
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
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function MyProcurementPage() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<"all" | "lwq" | "award">("all");

  const { data, isLoading, isError, refetch, isFetching } = useQuery<MyProcurementData>({
    queryKey: ["/api/my-procurement"],
    staleTime: 60_000,
    refetchInterval: 90_000,
  });

  const resolveMutation = useMutation({
    mutationFn: (laneId: string) =>
      apiRequest("POST", `/api/my-procurement/lwq-lane/${laneId}/resolve`).then((r) => r.json()),
    onMutate: async (laneId: string) => {
      await queryClient.cancelQueries({ queryKey: ["/api/my-procurement"] });
      const previous = queryClient.getQueryData<MyProcurementData>(["/api/my-procurement"]);
      queryClient.setQueryData<MyProcurementData>(["/api/my-procurement"], (old) => {
        if (!old) return old;
        return { ...old, lwqLanes: old.lwqLanes.filter((l) => l.laneId !== laneId) };
      });
      return { previous };
    },
    onSuccess: () => {
      toast({ title: "Lane marked as done" });
    },
    onError: (_err, _laneId, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(["/api/my-procurement"], ctx.previous);
      toast({ title: "Failed to mark done", variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/my-procurement"] });
    },
  });

  const closeMutation = useMutation({
    mutationFn: (taskId: string) =>
      apiRequest("POST", `/api/my-procurement/award-task/${taskId}/close`).then((r) => r.json()),
    onMutate: async (taskId: string) => {
      await queryClient.cancelQueries({ queryKey: ["/api/my-procurement"] });
      const previous = queryClient.getQueryData<MyProcurementData>(["/api/my-procurement"]);
      queryClient.setQueryData<MyProcurementData>(["/api/my-procurement"], (old) => {
        if (!old) return old;
        return { ...old, awardTasks: old.awardTasks.filter((t) => t.taskId !== taskId) };
      });
      return { previous };
    },
    onSuccess: () => {
      toast({ title: "Task closed" });
    },
    onError: (_err, _taskId, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(["/api/my-procurement"], ctx.previous);
      toast({ title: "Failed to close task", variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/my-procurement"] });
    },
  });

  const lwqLanes = data?.lwqLanes ?? [];
  const awardTasks = data?.awardTasks ?? [];
  const total = lwqLanes.length + awardTasks.length;
  const inProgress = lwqLanes.filter((l) => l.carriersContactedCount > 0).length;
  const matchedCount = awardTasks.filter((t) => t.matchedLaneId).length;

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header */}
      <div className="border-b px-6 py-4 bg-card shrink-0">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Briefcase className="w-5 h-5 text-primary" />
              My Procurement
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              All your active procurement work in one place — click any item to open the lane workspace
            </p>
          </div>
          <div className="flex items-center gap-3">
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
      <div className="flex-1 px-6 py-4">
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
            </TabsList>

            {/* All tab */}
            <TabsContent value="all">
              <div className="space-y-2">
                {lwqLanes.map((lane) => (
                  <LwqLaneCard
                    key={lane.laneId}
                    item={lane}
                    onResolve={(id) => resolveMutation.mutate(id)}
                  />
                ))}
                {awardTasks.map((task) => (
                  <AwardTaskCard
                    key={task.taskId}
                    item={task}
                    onClose={(id) => closeMutation.mutate(id)}
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
                    />
                  ))}
                </div>
              )}
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
                    />
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
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
