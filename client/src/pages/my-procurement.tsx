/**
 * My Procurement — Personal procurement work surface for the authenticated user.
 *
 * Shows two buckets unified into one view:
 *  1. LWQ Lane Assignments  — recurring lanes where I am the owner
 *  2. Award Procurement     — tasks of type carrier_procurement assigned to me
 *
 * Each item has a direct "Open in LWQ" action for immediate work.
 */

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { formatLaneDisplay } from "@shared/laneFormatters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Truck,
  Building2,
  ArrowRight,
  CheckCircle2,
  Clock,
  Briefcase,
  ListFilter,
  ChevronRight,
  Loader2,
  RefreshCw,
  Award,
  MapPin,
  AlertCircle,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ── Types ──────────────────────────────────────────────────────────────────────

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
}

interface AwardTask {
  taskId: string;
  title: string;
  status: string;
  dueDate: string | null;
  companyId: string | null;
  createdAt: string | null;
  lane: string | null;
  origin: string | null;
  destination: string | null;
  volume: number | null;
  awardId: string | null;
  awardTitle: string | null;
  customerName: string | null;
}

interface MyProcurementData {
  lwqLanes: LwqLane[];
  awardTasks: AwardTask[];
}

const COMPLETION_THRESHOLD = 3;

// ── Helpers ────────────────────────────────────────────────────────────────────

function daysAgo(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
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

// ── LWQ Lane Card ──────────────────────────────────────────────────────────────

function LwqLaneCard({ item, onResolve }: { item: LwqLane; onResolve: (id: string) => void }) {
  const [, navigate] = useLocation();
  const contacted = item.carriersContactedCount ?? 0;
  const laneDisplay = formatLaneDisplay(
    item.origin,
    item.originState,
    item.destination,
    item.destinationState
  );
  const equip = item.equipmentType ?? "—";
  const avgLoads = item.avgLoadsPerWeek
    ? `~${parseFloat(item.avgLoadsPerWeek).toFixed(1)} loads/wk`
    : null;

  return (
    <div
      className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-lg border bg-card hover:bg-accent/5 transition-colors"
      data-testid={`card-lwq-lane-${item.laneId}`}
    >
      {/* Lane identity */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Truck className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="font-semibold text-sm truncate" data-testid={`text-lane-${item.laneId}`}>
            {laneDisplay}
          </span>
          {item.isManual && (
            <Badge variant="outline" className="text-xs border-blue-700 text-blue-400 bg-blue-950/30">
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
        </div>
        <div className="mt-2">
          <ProgressPips contacted={contacted} threshold={COMPLETION_THRESHOLD} />
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 shrink-0">
        <Button
          size="sm"
          variant="default"
          className="h-8 text-xs gap-1.5"
          data-testid={`btn-open-lwq-${item.laneId}`}
          onClick={() => navigate(`/lanes/work-queue?laneId=${item.laneId}`)}
        >
          <ListFilter className="w-3.5 h-3.5" />
          Open in LWQ
          <ChevronRight className="w-3 h-3" />
        </Button>
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
      : item.lane ?? "Unknown lane";
  const volumeStr =
    item.volume && item.volume > 0
      ? `${item.volume.toLocaleString()} loads/yr`
      : null;

  return (
    <div
      className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-lg border bg-card hover:bg-accent/5 transition-colors"
      data-testid={`card-award-task-${item.taskId}`}
    >
      {/* Lane identity */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Award className="w-4 h-4 text-amber-500 shrink-0" />
          <span className="font-semibold text-sm truncate" data-testid={`text-lane-award-${item.taskId}`}>
            {laneDisplay}
          </span>
          {item.awardTitle && (
            <Badge variant="outline" className="text-xs border-amber-700 text-amber-400 bg-amber-950/30">
              {item.awardTitle}
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
          {volumeStr && (
            <span className="flex items-center gap-1">
              <MapPin className="w-3 h-3" />
              {volumeStr}
            </span>
          )}
          <AgeBadge dateStr={item.createdAt} label="Created" />
          {item.dueDate && (
            <span className="flex items-center gap-1 text-orange-400">
              <Clock className="w-3 h-3" />
              Due {new Date(item.dueDate).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 shrink-0">
        {item.awardId && (
          <Button
            size="sm"
            variant="default"
            className="h-8 text-xs gap-1.5"
            data-testid={`btn-open-award-${item.taskId}`}
            onClick={() =>
              navigate(`/rfp-awards?awardId=${item.awardId}&tab=lanes`)
            }
          >
            <Award className="w-3.5 h-3.5" />
            View Award
            <ChevronRight className="w-3 h-3" />
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
  const { user } = useAuth();
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
    onSuccess: () => {
      toast({ title: "Lane marked as done" });
      queryClient.invalidateQueries({ queryKey: ["/api/my-procurement"] });
    },
    onError: () => toast({ title: "Failed to mark done", variant: "destructive" }),
  });

  const closeMutation = useMutation({
    mutationFn: (taskId: string) =>
      apiRequest("POST", `/api/my-procurement/award-task/${taskId}/close`).then((r) => r.json()),
    onSuccess: () => {
      toast({ title: "Task closed" });
      queryClient.invalidateQueries({ queryKey: ["/api/my-procurement"] });
    },
    onError: () => toast({ title: "Failed to close task", variant: "destructive" }),
  });

  const lwqLanes = data?.lwqLanes ?? [];
  const awardTasks = data?.awardTasks ?? [];
  const total = lwqLanes.length + awardTasks.length;
  const inProgress = lwqLanes.filter((l) => l.carriersContactedCount > 0).length;

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
              Your active lane assignments and award procurement tasks in one view
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
          <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
            <Loader2 className="w-5 h-5 animate-spin" />
            Loading your procurement items…
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
                <ListFilter className="w-3.5 h-3.5 mr-1.5" />
                Lane Assignments ({lwqLanes.length})
              </TabsTrigger>
              <TabsTrigger value="award" data-testid="tab-award">
                <Award className="w-3.5 h-3.5 mr-1.5" />
                Award Tasks ({awardTasks.length})
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
