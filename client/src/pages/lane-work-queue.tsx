/**
 * Lane Work Queue — Manager / Director / Admin view
 *
 * Shows eligible recurring lanes bucketed into four operational states:
 *   1. Unassigned        — no owner yet
 *   2. No Contactable    — assigned but 0 carriers have phone/email
 *   3. Assigned Untouched — assigned + contactable, 0 contacted so far
 *   4. In Progress       — 1+ contacted, not yet complete
 *
 * Clicking a row opens CarrierOutreachPanel for immediate action.
 */

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
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
} from "lucide-react";
import { CarrierOutreachPanel } from "@/components/CarrierOutreachPanel";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@tanstack/react-query";

// ── Types ─────────────────────────────────────────────────────────────────────

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
  };
  contactableCount: number;
  totalBenchCount: number;
  historicalCount: number;
  missingContactCount: number;
}

interface WorkQueue {
  unassigned: LaneItem[];
  noContactable: LaneItem[];
  assignedUntouched: LaneItem[];
  inProgress: LaneItem[];
  scopeLabel?: string;
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const HIGH_FREQ_THRESHOLD = 2; // loads/week — main procurement priority

function laneLabel(item: LaneItem["lane"]) {
  const origin = `${item.origin}${item.originState ? ", " + item.originState : ""}`;
  const dest = `${item.destination}${item.destinationState ? ", " + item.destinationState : ""}`;
  return `${origin} → ${dest}`;
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
  if (n >= 3) {
    return (
      <Badge
        variant="outline"
        className="text-[10px] py-0 px-1.5 border-emerald-500/50 text-emerald-400 bg-emerald-500/10 gap-0.5"
        data-testid="freq-badge-high"
      >
        <Zap className="w-2.5 h-2.5" />
        {n.toFixed(1)}/wk
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
        {n.toFixed(1)}/wk
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-[10px] py-0 px-1.5 border-slate-500/30 text-muted-foreground"
      data-testid="freq-badge-low"
    >
      {n.toFixed(1)}/wk
    </Badge>
  );
}

function avgLoadsNum(val: string | null | undefined): number {
  return parseLoadsPerWeek(val) ?? 0;
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

  const selfAssignMutation = useMutation({
    mutationFn: (ownerUserId: string | null) =>
      apiRequest("POST", `/api/recurring-lanes/${item.lane.id}/assign`, { ownerUserId }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: "Lane assigned" });
    },
    onError: () => toast({ title: "Assignment failed", variant: "destructive" }),
  });

  const contacted = item.lane.carriersContactedCount ?? 0;
  const progressPct = Math.min(100, (contacted / completionThreshold) * 100);
  const loadsNum = avgLoadsNum(item.lane.avgLoadsPerWeek);
  const isHighFreq = loadsNum >= HIGH_FREQ_THRESHOLD;

  return (
    <div
      className={`bg-card border rounded-lg p-4 hover:border-amber-500/30 transition-colors cursor-pointer group ${
        isHighFreq ? "border-amber-500/20" : "border-border"
      }`}
      onClick={() => onOpen(item.lane.id)}
      data-testid={`work-queue-row-${item.lane.id}`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {/* Lane label + badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{laneLabel(item.lane)}</span>
            {/* Frequency badge — prominent, always first */}
            <FrequencyBadge val={item.lane.avgLoadsPerWeek} />
            <Badge variant="outline" className="text-[10px] py-0 px-1.5">
              {item.lane.equipmentType ?? "Any"}
            </Badge>
            <Badge variant="outline" className={`text-[10px] py-0 px-1.5 capitalize ${confidenceColor(item.lane.eligibilityConfidence)}`}>
              {item.lane.eligibilityConfidence}
            </Badge>
          </div>
          {item.lane.companyName && (
            <p className="text-xs text-muted-foreground mt-0.5">{item.lane.companyName}</p>
          )}

          {/* Metrics row */}
          <div className="flex items-center gap-4 mt-2 flex-wrap">
            <span className="text-[11px] text-muted-foreground">
              Score: <span className="text-foreground font-medium">{item.lane.laneScore ?? "—"}</span>
            </span>
            <span className="text-[11px] text-muted-foreground">
              Bench: <span className="text-foreground font-medium">{item.totalBenchCount}</span>
              {item.historicalCount > 0 && (
                <span className="text-blue-500 ml-1">({item.historicalCount} historical)</span>
              )}
            </span>
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

        {/* Right caret */}
        <ChevronRight className="w-4 h-4 text-muted-foreground/40 shrink-0 mt-1 group-hover:text-amber-400 transition-colors" />
      </div>
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

  const visibleItems = useMemo(() => {
    const sorted = sortItems(items);
    return highFreqOnly ? sorted.filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD) : sorted;
  }, [items, highFreqOnly]);

  const hiddenCount = items.length - visibleItems.length;

  return (
    <section className="mb-6" data-testid={`bucket-${bucket}`}>
      <button
        className="w-full flex items-center gap-3 mb-3 text-left"
        onClick={() => setCollapsed(v => !v)}
      >
        <div className={`w-7 h-7 rounded-md flex items-center justify-center ${iconColor}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            <Badge variant="secondary" className="text-[10px] h-5 px-1.5">{visibleItems.length}</Badge>
            {highFreqOnly && hiddenCount > 0 && (
              <span className="text-[10px] text-muted-foreground/50">(+{hiddenCount} below 2/wk hidden)</span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">{description}</p>
        </div>
        <ChevronRight className={`w-4 h-4 text-muted-foreground/50 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`} />
      </button>

      {!collapsed && (
        <div className="flex flex-col gap-2">
          {visibleItems.length === 0 ? (
            <p className="text-xs text-muted-foreground italic py-2 pl-10">
              {highFreqOnly && items.length > 0
                ? "No 2+/week lanes in this bucket."
                : "No lanes in this bucket."}
            </p>
          ) : (
            visibleItems.map(item => (
              <LaneRow
                key={item.lane.id}
                item={item}
                completionThreshold={completionThreshold}
                onOpen={onOpen}
                bucket={bucket}
                teamMembers={teamMembers}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function LaneWorkQueuePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [openLaneId, setOpenLaneId] = useState<string | null>(null);
  const [highFreqOnly, setHighFreqOnly] = useState(false);

  const managerRoles = ["admin", "director", "national_account_manager", "logistics_manager"];
  const isManager = managerRoles.includes(user?.role ?? "");

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
    enabled: isManager,
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

  // Count high-frequency lanes across all buckets for the filter chip label
  const highFreqCount = useMemo(() => {
    if (!queue) return 0;
    return (
      queue.unassigned.filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD).length +
      queue.noContactable.filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD).length +
      queue.assignedUntouched.filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD).length +
      queue.inProgress.filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD).length
    );
  }, [queue]);

  if (!isManager) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="w-8 h-8 text-orange-400 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Manager access required to view the Lane Work Queue.</p>
        </div>
      </div>
    );
  }

  const totalLanes = (queue?.unassigned.length ?? 0) +
    (queue?.noContactable.length ?? 0) +
    (queue?.assignedUntouched.length ?? 0) +
    (queue?.inProgress.length ?? 0);

  // Sort unassigned by avgLoadsPerWeek descending so highest-frequency lanes appear first
  const sortedUnassigned = [...(queue?.unassigned ?? [])].sort((a, b) => {
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
            <h1 className="text-lg font-bold text-foreground">Lane Work Queue</h1>
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
        <div className="flex items-center gap-2">
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
            {/* Summary stat chips */}
            {queue && (
              <div className="flex gap-3 flex-wrap mb-6">
                <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]">
                  <p className="text-lg font-bold text-orange-400">{queue.unassigned.length}</p>
                  <p className="text-[10px] text-orange-400/70">Unassigned</p>
                </div>
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]">
                  <p className="text-lg font-bold text-red-400">{queue.noContactable.length}</p>
                  <p className="text-[10px] text-red-400/70">No Contact Info</p>
                </div>
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]">
                  <p className="text-lg font-bold text-blue-400">{queue.assignedUntouched.length}</p>
                  <p className="text-[10px] text-blue-400/70">Untouched</p>
                </div>
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]">
                  <p className="text-lg font-bold text-amber-400">{queue.inProgress.length}</p>
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

            {/* Buckets */}
            {queue && (
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
                  items={queue.noContactable}
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
                  items={queue.assignedUntouched}
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
                  items={queue.inProgress}
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
