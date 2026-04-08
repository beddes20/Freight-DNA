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

  // Team members eligible for assignment (non-admin, non-director roles are the "doers")
  const assignableMembers = teamMembers.filter(m =>
    ["account_manager", "logistics_manager", "logistics_coordinator", "national_account_manager"].includes(m.role)
  );
  // Fall back to all team members if no matching operational roles found
  const dropdownMembers = assignableMembers.length > 0 ? assignableMembers : teamMembers;

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
            {/* 2+/week high-frequency badge */}
            {isHighFreq && (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400"
                data-testid={`badge-high-freq-${item.lane.id}`}
              >
                <Zap className="w-2.5 h-2.5" />
                {item.lane.avgLoadsPerWeek}/wk
              </span>
            )}
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

<<<<<<< HEAD
            {/* Assign-to dropdown — managers can pick any team member; non-managers get "Assign to me" */}
            {!item.lane.ownerUserId && (
              <>
                {isManagerRole && dropdownMembers.length > 0 ? (
                  <Select
                    onValueChange={(val) => assignMutation.mutate(val)}
                    disabled={assignMutation.isPending}
                  >
                    <SelectTrigger
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
                {isManager && teamMembers.length > 1 && (
                  <AssignToDropdown
                    laneId={item.lane.id}
                    teamMembers={teamMembers.filter(m => m.id !== currentUser.id)}
                    onAssigned={() => {}}
                  />
                )}
              </>
            )}
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
<<<<<<< HEAD
  isManagerRole: boolean;
  filterHighFreq?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const displayItems = filterHighFreq
    ? items.filter(item => (parseLoadsPerWeek(item.lane.avgLoadsPerWeek) ?? 0) >= 2)
    : items;
=======
  highFreqOnly: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const visibleItems = useMemo(() => {
    const sorted = sortItems(items);
    return highFreqOnly ? sorted.filter(i => avgLoadsNum(i.lane.avgLoadsPerWeek) >= HIGH_FREQ_THRESHOLD) : sorted;
  }, [items, highFreqOnly]);

  const hiddenCount = items.length - visibleItems.length;
>>>>>>> 90ffed5 (Lane Work Queue: visibility, assignment UX, and 2+/week clarity improvements)

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
