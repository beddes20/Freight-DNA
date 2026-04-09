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

import { useState, useMemo, useEffect } from "react";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
    isManual: boolean;
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
    onSuccess: (_data, ownerUserId) => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: ownerUserId === null ? "Lane unassigned" : "Lane assigned" });
    },
    onError: () => toast({ title: "Assignment failed", variant: "destructive" }),
  });

  const canUnassign = item.lane.ownerUserId &&
    (isManager || item.lane.ownerUserId === currentUser?.id);

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

        {/* Right caret */}
        <ChevronRight className="w-4 h-4 text-muted-foreground/40 shrink-0 mt-1 group-hover:text-amber-400 transition-colors" />
      </div>
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

  const buildMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/lanes/manual", {
        origin: form.origin.trim(),
        originState: form.originState.trim() || undefined,
        destination: form.destination.trim(),
        destinationState: form.destinationState.trim() || undefined,
        equipmentType: form.equipmentType || undefined,
        avgLoadsPerWeek: form.avgLoadsPerWeek ? parseFloat(form.avgLoadsPerWeek) : undefined,
        companyName: form.companyName.trim() || undefined,
        notes: form.notes.trim() || undefined,
      }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: "Lane created", description: "Manual lane added to the work queue." });
      onCreated();
      onClose();
      setForm({ origin: "", originState: "", destination: "", destinationState: "", equipmentType: "", avgLoadsPerWeek: "", companyName: "", notes: "" });
    },
    onError: () => toast({ title: "Failed to create lane", variant: "destructive" }),
  });

  const canSubmit = form.origin.trim().length > 0 && form.destination.trim().length > 0;

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
                onChange={e => setForm(f => ({ ...f, origin: e.target.value }))}
                data-testid="input-build-origin"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="build-origin-state" className="text-xs">Origin State</Label>
              <Input
                id="build-origin-state"
                placeholder="e.g. UT"
                maxLength={2}
                value={form.originState}
                onChange={e => setForm(f => ({ ...f, originState: e.target.value.toUpperCase() }))}
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
                onChange={e => setForm(f => ({ ...f, destination: e.target.value }))}
                data-testid="input-build-dest"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="build-dest-state" className="text-xs">Destination State</Label>
              <Input
                id="build-dest-state"
                placeholder="e.g. TX"
                maxLength={2}
                value={form.destinationState}
                onChange={e => setForm(f => ({ ...f, destinationState: e.target.value.toUpperCase() }))}
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

  // Auto-open a specific lane when ?laneId=... is in the URL (cross-link from Carrier Hub)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const lid = params.get("laneId");
    if (lid) setOpenLaneId(lid);
  }, []);

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
    if (!queue) return null;
    return {
      unassigned: filterBucket(queue.unassigned),
      noContactable: filterBucket(queue.noContactable),
      assignedUntouched: filterBucket(queue.assignedUntouched),
      inProgress: filterBucket(queue.inProgress),
    };
  }, [queue, customerFilter, highFreqOnly]);

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
