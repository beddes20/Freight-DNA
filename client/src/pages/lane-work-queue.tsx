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

import { useState } from "react";
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
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Lane Row ──────────────────────────────────────────────────────────────────

function LaneRow({
  item,
  completionThreshold,
  onOpen,
  bucket,
  teamMembers,
  isManagerRole,
}: {
  item: LaneItem;
  completionThreshold: number;
  onOpen: (laneId: string) => void;
  bucket: keyof WorkQueue;
  teamMembers: TeamMember[];
  isManagerRole: boolean;
}) {
  const { toast } = useToast();
  const { user: currentUser } = useAuth();

  const assignMutation = useMutation({
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

  // Team members eligible for assignment (non-admin, non-director roles are the "doers")
  const assignableMembers = teamMembers.filter(m =>
    ["account_manager", "logistics_manager", "logistics_coordinator", "national_account_manager"].includes(m.role)
  );
  // Fall back to all team members if no matching operational roles found
  const dropdownMembers = assignableMembers.length > 0 ? assignableMembers : teamMembers;

  return (
    <div
      className="bg-card border border-border rounded-lg p-4 hover:border-amber-500/30 transition-colors cursor-pointer group"
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

          {/* Owner chip / assign controls */}
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

            {/* Assign-to dropdown — managers can pick any team member; non-managers get "Assign to me" */}
            {!item.lane.ownerUserId && (
              <>
                {isManagerRole && dropdownMembers.length > 0 ? (
                  <Select
                    onValueChange={(val) => assignMutation.mutate(val)}
                    disabled={assignMutation.isPending}
                  >
                    <SelectTrigger
                      className="h-6 text-[10px] w-auto min-w-[110px] px-2 border-blue-400/30 text-blue-400 hover:bg-blue-500/10 bg-transparent"
                      data-testid={`select-assign-${item.lane.id}`}
                    >
                      <SelectValue placeholder="Assign to…" />
                    </SelectTrigger>
                    <SelectContent>
                      {dropdownMembers.map(m => (
                        <SelectItem key={m.id} value={m.id} className="text-xs">
                          {m.name}
                          <span className="text-muted-foreground ml-1">
                            ({m.role.replace(/_/g, " ")})
                          </span>
                        </SelectItem>
                      ))}
                      {currentUser && !dropdownMembers.find(m => m.id === currentUser.id) && (
                        <SelectItem key="self" value={currentUser.id} className="text-xs">
                          Me ({currentUser.name})
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                ) : (
                  currentUser && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px] px-2 border-blue-400/30 text-blue-400 hover:bg-blue-500/10"
                      onClick={() => assignMutation.mutate(currentUser.id)}
                      disabled={assignMutation.isPending}
                      data-testid={`btn-assign-self-${item.lane.id}`}
                    >
                      {assignMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Assign to me"}
                    </Button>
                  )
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
  isManagerRole,
  filterHighFreq,
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
  isManagerRole: boolean;
  filterHighFreq?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const displayItems = filterHighFreq
    ? items.filter(item => (parseLoadsPerWeek(item.lane.avgLoadsPerWeek) ?? 0) >= 2)
    : items;

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
            <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
              {filterHighFreq ? `${displayItems.length} of ${items.length}` : items.length}
            </Badge>
          </div>
          <p className="text-[11px] text-muted-foreground">{description}</p>
        </div>
        <ChevronRight className={`w-4 h-4 text-muted-foreground/50 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`} />
      </button>

      {!collapsed && (
        <div className="flex flex-col gap-2">
          {displayItems.length === 0 ? (
            <p className="text-xs text-muted-foreground italic py-2 pl-10">
              {filterHighFreq && items.length > 0 ? "No 2+/wk lanes in this bucket." : "No lanes in this bucket."}
            </p>
          ) : (
            displayItems.map(item => (
              <LaneRow
                key={item.lane.id}
                item={item}
                completionThreshold={completionThreshold}
                onOpen={onOpen}
                bucket={bucket}
                teamMembers={teamMembers}
                isManagerRole={isManagerRole}
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
  const [openLaneId, setOpenLaneId] = useState<string | null>(null);
  const [filterHighFreq, setFilterHighFreq] = useState(false);

  const managerRoles = ["admin", "director", "national_account_manager", "logistics_manager"];
  const isManager = managerRoles.includes(user?.role ?? "");

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

  // Count 2+/wk lanes in unassigned bucket for the filter pill label
  const highFreqUnassignedCount = sortedUnassigned.filter(
    item => (parseLoadsPerWeek(item.lane.avgLoadsPerWeek) ?? 0) >= 2
  ).length;

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
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* 2+/wk filter pill */}
          {!isLoading && highFreqUnassignedCount > 0 && (
            <Button
              variant={filterHighFreq ? "default" : "outline"}
              size="sm"
              className={`h-8 text-xs gap-1.5 ${filterHighFreq ? "bg-amber-500 hover:bg-amber-600 text-white border-amber-500" : "border-amber-500/40 text-amber-400 hover:bg-amber-500/10"}`}
              onClick={() => setFilterHighFreq(v => !v)}
              data-testid="btn-filter-high-freq"
            >
              <Zap className="w-3.5 h-3.5" />
              2+/wk {filterHighFreq ? "✕" : `(${highFreqUnassignedCount})`}
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
                {highFreqUnassignedCount > 0 && (
                  <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2 text-center min-w-[80px]">
                    <p className="text-lg font-bold text-emerald-400">{highFreqUnassignedCount}</p>
                    <p className="text-[10px] text-emerald-400/70">2+/wk Unassigned</p>
                  </div>
                )}
              </div>
            )}

            {/* Buckets */}
            {queue && (
              <>
                <BucketSection
                  title="Unassigned"
                  description={
                    filterHighFreq
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
                  isManagerRole={isManager}
                  filterHighFreq={filterHighFreq}
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
                  isManagerRole={isManager}
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
                  isManagerRole={isManager}
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
                  isManagerRole={isManager}
                />
              </>
            )}

            {!isLoading && totalLanes === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <CheckCircle2 className="w-10 h-10 text-emerald-400 mb-3" />
                <p className="text-sm font-semibold text-foreground">All caught up!</p>
                <p className="text-xs text-muted-foreground mt-1">No eligible lanes need attention right now.</p>
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
                              {" | "}{item.lane.avgLoadsPerWeek ?? "?"}loads/wk
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
