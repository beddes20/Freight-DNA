/**
 * CarrierOutreachPanel
 *
 * Side panel for the "Lock In Capacity on [Origin → Destination]" NBA card.
 * Lets NAMs/AMs/LMs:
 *   1. See the lane details + lane score
 *   2. Browse AI-ranked carrier suggestions
 *   3. Draft lane-building outreach emails
 *   4. Mark carriers as contacted (triggers outreach log)
 *   5. Classify carrier replies
 *   6. Receive follow-up suggestions
 *   7. Switch between "Lane-Building" and "Immediate + Lane" outreach modes
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowRight,
  Truck,
  Star,
  Mail,
  CheckCircle2,
  RefreshCw,
  Lightbulb,
  ClipboardCheck,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Loader2,
  User,
  UserCheck,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface RecurringLane {
  id: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  avgLoadsPerWeek: string | null;
  weeksActive: number | null;
  lookbackWeeks: number | null;
  laneScore: number | null;
  eligibilityConfidence: string;
  companyId: string | null;
  companyName: string | null;
  carriersContactedCount: number | null;
  hasPreferredCarrierProgram: boolean;
  resolvedAt: string | null;
  ownerUserId: string | null;
  overseerUserId: string | null;
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
}

interface RankedCarrier {
  carrierId: string | null;
  carrierName: string;
  primaryEmail: string | null;
  backupEmail: string | null;
  fitScore: number;
  fitReason: string;
  historyMatch: string;
  loadsOnLane: number;
  lastUsedMonth: string | null;
  isNewProspect: boolean;
  regions: string[];
  equipmentTypes: string[];
  tags: string[];
}

interface EmailDraft {
  carrierId: string | null;
  carrierName: string;
  subject: string;
  body: string;
  outreachMode: string;
}

interface CarrierInterest {
  id: string;
  carrierId: string | null;
  carrierName: string;
  interestStatus: string;
  fitScore: number | null;
  fitReason: string | null;
  outreachSentAt: string | null;
  lastReplySnippet: string | null;
  classifiedAt: string | null;
  sourceType: string | null;        // 'historical' | 'suggested' | 'manually_added'
  phone: string | null;
  primaryEmail: string | null;
  isContactable: boolean;
}

interface FollowupSuggestion {
  type: string;
  priority: "high" | "medium" | "low";
  message: string;
  carrierId?: string | null;
  carrierName?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const INTEREST_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  available_now:      { label: "Available Now",    color: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  available_next_week:{ label: "Next Week",         color: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30" },
  future_interest:    { label: "Future Interest",   color: "bg-violet-500/20 text-violet-300 border-violet-500/30" },
  not_fit:            { label: "Not a Fit",         color: "bg-red-500/20 text-red-300 border-red-500/30" },
  needs_follow_up:    { label: "Needs Follow-up",   color: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
};

const HISTORY_MATCH_LABELS: Record<string, string> = {
  exact:   "Ran this lane",
  similar: "Similar corridor",
  region:  "In region",
  none:    "New prospect",
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface CarrierOutreachPanelProps {
  laneId: string | null;
  companyId?: string | null;
  open: boolean;
  onClose: () => void;
  onCarriersContacted?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CarrierOutreachPanel({
  laneId: laneIdProp,
  companyId,
  open,
  onClose,
  onCarriersContacted,
}: CarrierOutreachPanelProps) {
  // If no laneId given, resolve it from the company's best recurring lane
  const { data: companyLanes } = useQuery<RecurringLane[]>({
    queryKey: ["/api/recurring-lanes"],
    queryFn: () => fetch("/api/recurring-lanes").then(r => r.json()),
    enabled: !laneIdProp && !!companyId && open,
  });

  const laneId = laneIdProp ?? (
    companyId
      ? (companyLanes ?? [])
          // IMPORTANT: filter by companyId to avoid showing outreach for wrong account
          .filter(l => l.companyId === companyId && !l.resolvedAt && !l.hasPreferredCarrierProgram)
          .sort((a, b) => (b.laneScore ?? 0) - (a.laneScore ?? 0))[0]?.id ?? null
      : null
  );

  const { data: outreachConfig } = useQuery<{ completionCarriersContacted: number }>({
    queryKey: ["/api/lane-outreach-config"],
    queryFn: () => fetch("/api/lane-outreach-config").then(r => r.json()),
    staleTime: 5 * 60 * 1000,
  });
  const completionThreshold = outreachConfig?.completionCarriersContacted ?? 3;

  const { data: teamMembers = [] } = useQuery<TeamMember[]>({
    queryKey: ["/api/team-members"],
    queryFn: () => fetch("/api/team-members").then(r => r.json()),
    enabled: open,
  });
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuth();
  const isDirectorOrAdmin = ["admin", "director"].includes(currentUser?.role ?? "");
  const isManager = ["admin", "director", "national_account_manager", "logistics_manager"].includes(currentUser?.role ?? "");

  const [selectedCarriers, setSelectedCarriers] = useState<Set<string>>(new Set());
  const [outreachMode, setOutreachMode] = useState<"lane_building" | "immediate_plus_lane">("lane_building");
  const [emailDrafts, setEmailDrafts] = useState<EmailDraft[]>([]);
  const [showEmails, setShowEmails] = useState(false);
  const [replyInputs, setReplyInputs] = useState<Record<string, string>>({});
  const [expandedReply, setExpandedReply] = useState<string | null>(null);
  // Carrier suggestion filters
  const [activeOnly, setActiveOnly] = useState(false);
  const [excludeServiceFlags, setExcludeServiceFlags] = useState(false);
  // Inline email notes per carrier (keyed by carrierId ?? carrierName)
  const [inlineEmails, setInlineEmails] = useState<Record<string, string>>({});
  // User-entered email addresses for carriers that have no primaryEmail in the catalog
  const [capturedEmails, setCapturedEmails] = useState<Record<string, string>>({});
  // Shared outreach template that applies to all selected carriers
  const [sharedTemplate, setSharedTemplate] = useState("");

  // ── Data fetching ──────────────────────────────────────────────────────────

  const { data: lane, isLoading: laneLoading } = useQuery<RecurringLane>({
    queryKey: ["/api/recurring-lanes", laneId],
    queryFn: () => fetch(`/api/recurring-lanes/${laneId}`).then(r => r.json()),
    enabled: !!laneId && open,
  });

  const { data: suggestionsData, isLoading: suggestionsLoading } = useQuery<{ carriers: RankedCarrier[] }>({
    queryKey: ["/api/lanes", laneId, "carrier-suggestions"],
    queryFn: () => fetch(`/api/lanes/${laneId}/carrier-suggestions`).then(r => r.json()),
    enabled: !!laneId && open,
  });

  const { data: bench = [], refetch: refetchBench } = useQuery<CarrierInterest[]>({
    queryKey: ["/api/lanes", laneId, "carrier-bench"],
    queryFn: () => fetch(`/api/lanes/${laneId}/carrier-bench`).then(r => r.json()),
    enabled: !!laneId && open,
  });

  const { data: followupData, isLoading: followupLoading } = useQuery<{ suggestions: FollowupSuggestion[] }>({
    queryKey: ["/api/lanes", laneId, "followup-suggestions"],
    queryFn: () => fetch(`/api/lanes/${laneId}/followup-suggestions`).then(r => r.json()),
    enabled: !!laneId && open,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────

  const draftEmailsMutation = useMutation({
    mutationFn: (body: { carrierIds: (string | null)[]; carrierNames: string[]; outreachMode: string }) =>
      apiRequest("POST", `/api/lanes/${laneId}/draft-outreach-emails`, body).then(r => r.json()),
    onSuccess: (data: { emails: EmailDraft[] }) => {
      setEmailDrafts(data.emails ?? []);
      setShowEmails(true);
    },
    onError: () => toast({ title: "Email drafting failed", variant: "destructive" }),
  });

  const outreachLogMutation = useMutation({
    mutationFn: (body: { carrierIds: (string | null)[]; carrierNames: string[]; outreachMode: string; emailDrafts: EmailDraft[]; capturedEmails?: Record<string, string> }) =>
      apiRequest("POST", `/api/lanes/${laneId}/outreach-log`, body).then(r => r.json()),
    onSuccess: (data: { carriersContactedCount: number; resolved: boolean }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes", laneId] });
      queryClient.invalidateQueries({ queryKey: ["/api/lanes", laneId, "carrier-bench"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lanes", laneId, "followup-suggestions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/nba/cards"] });
      setSelectedCarriers(new Set());
      setEmailDrafts([]);
      setShowEmails(false);
      refetchBench();
      if (data.resolved) {
        // Only signal card completion (which hides the NBA card) when the lane bench is full
        onCarriersContacted?.();
        toast({ title: "Lane bench complete!", description: `${completionThreshold}+ carriers contacted — card resolved. Snoozing 30 days.` });
      } else {
        toast({ title: `${data.carriersContactedCount} carrier(s) marked as contacted` });
      }
    },
    onError: () => toast({ title: "Failed to log outreach", variant: "destructive" }),
  });

  const classifyReplyMutation = useMutation({
    mutationFn: (body: { replyText: string; carrierId: string | null; carrierName: string; interestId?: string }) =>
      apiRequest("POST", `/api/lanes/${laneId}/classify-reply`, body).then(r => r.json()),
    onSuccess: () => {
      refetchBench();
      queryClient.invalidateQueries({ queryKey: ["/api/lanes", laneId, "followup-suggestions"] });
      toast({ title: "Reply classified" });
    },
    onError: () => toast({ title: "Classification failed", variant: "destructive" }),
  });

  const reassignMutation = useMutation({
    mutationFn: (body: { ownerUserId?: string; overseerUserId?: string }) =>
      apiRequest("PATCH", `/api/recurring-lanes/${laneId}`, body).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes", laneId] });
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes"] });
      toast({ title: "Lane reassigned" });
    },
    onError: () => toast({ title: "Reassignment failed", variant: "destructive" }),
  });

  const assignLaneMutation = useMutation({
    mutationFn: (ownerUserId: string | null) =>
      apiRequest("POST", `/api/recurring-lanes/${laneId}/assign`, { ownerUserId }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes", laneId] });
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: "Lane assigned" });
    },
    onError: () => toast({ title: "Assignment failed", variant: "destructive" }),
  });

  const setInterestStatusMutation = useMutation({
    mutationFn: (body: { carrierId: string | null; carrierName: string; interestStatus: string }) =>
      apiRequest("POST", `/api/lanes/${laneId}/carrier-interest`, body).then(r => r.json()),
    onSuccess: () => {
      refetchBench();
      toast({ title: "Interest status updated" });
    },
    onError: () => toast({ title: "Failed to update status", variant: "destructive" }),
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  const rankedCarriers = suggestionsData?.carriers ?? [];

  // Apply frontend filters
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  const filteredCarriers = rankedCarriers.filter(c => {
    if (activeOnly) {
      if (!c.lastUsedMonth) return false;
      const lastDate = new Date(c.lastUsedMonth + "-01");
      if (Date.now() - lastDate.getTime() > NINETY_DAYS_MS) return false;
    }
    if (excludeServiceFlags) {
      const flagTags = ["do_not_use", "service_flag", "flagged", "no_use"];
      if (c.tags.some(t => flagTags.includes(t.toLowerCase()))) return false;
    }
    return true;
  });

  function toggleCarrier(c: RankedCarrier) {
    setSelectedCarriers(prev => {
      const next = new Set(prev);
      const key = c.carrierId ?? c.carrierName;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleGenerateOutreach() {
    const selected = filteredCarriers.filter(c => selectedCarriers.has(c.carrierId ?? c.carrierName));
    if (selected.length === 0) {
      toast({ title: "Select at least one carrier first" });
      return;
    }
    // If user has provided a shared template, apply it to all selected carriers directly
    // (skip AI drafting — the shared template IS the email body, personalized only by carrier name)
    if (sharedTemplate.trim()) {
      const origin = lane ? `${lane.origin}${lane.originState ? ", " + lane.originState : ""}` : "";
      const dest = lane ? `${lane.destination}${lane.destinationState ? ", " + lane.destinationState : ""}` : "";
      const equipment = lane?.equipmentType ?? "dry van";
      const drafts: EmailDraft[] = selected.map(c => ({
        carrierId: c.carrierId,
        carrierName: c.carrierName,
        subject: `Lane-Building Opportunity: ${origin} → ${dest} (${equipment})`,
        body: sharedTemplate.trim(),
        outreachMode,
      }));
      setEmailDrafts(drafts);
      setShowEmails(true);
      return;
    }
    draftEmailsMutation.mutate({
      carrierIds: selected.map(c => c.carrierId),
      carrierNames: selected.map(c => c.carrierName),
      outreachMode,
    });
  }

  function handleLogOutreach() {
    const selected = filteredCarriers.filter(c => selectedCarriers.has(c.carrierId ?? c.carrierName));
    if (selected.length === 0) {
      toast({ title: "Select at least one carrier first" });
      return;
    }
    // Merge any inline email notes into the draft list
    const allDrafts: EmailDraft[] = [...emailDrafts];
    for (const c of selected) {
      const key = c.carrierId ?? c.carrierName;
      const note = inlineEmails[key]?.trim();
      if (note && !allDrafts.some(d => d.carrierName === c.carrierName)) {
        allDrafts.push({ carrierId: c.carrierId, carrierName: c.carrierName, subject: `Lane-Building Outreach — ${c.carrierName}`, body: note, outreachMode });
      }
    }
    // Include any captured emails so the server can persist them to the carrier catalog
    const emailsToSave: Record<string, string> = {};
    for (const c of selected) {
      const key = c.carrierId ?? c.carrierName;
      if (capturedEmails[key]?.trim()) emailsToSave[key] = capturedEmails[key].trim();
    }
    outreachLogMutation.mutate({
      carrierIds: selected.map(c => c.carrierId),
      carrierNames: selected.map(c => c.carrierName),
      outreachMode,
      emailDrafts: allDrafts,
      capturedEmails: Object.keys(emailsToSave).length > 0 ? emailsToSave : undefined,
    });
  }

  function handleClassifyReply(interest: CarrierInterest) {
    const text = replyInputs[interest.id] ?? "";
    if (!text.trim()) return;
    classifyReplyMutation.mutate({
      replyText: text,
      carrierId: interest.carrierId,
      carrierName: interest.carrierName,
      interestId: interest.id,
    });
    setReplyInputs(prev => ({ ...prev, [interest.id]: "" }));
    setExpandedReply(null);
  }

  function laneLabel(l: RecurringLane | undefined) {
    if (!l) return "";
    const origin = `${l.origin}${l.originState ? ", " + l.originState : ""}`;
    const dest = `${l.destination}${l.destinationState ? ", " + l.destinationState : ""}`;
    return `${origin} → ${dest}`;
  }

  const contactedCount = lane?.carriersContactedCount ?? 0;
  const progressPct = Math.min(100, (contactedCount / completionThreshold) * 100);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl bg-slate-900 border-white/10 text-white overflow-y-auto p-0"
        data-testid="carrier-outreach-panel"
      >
        {/* Header */}
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-white/8">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-amber-500/20 flex items-center justify-center">
              <Truck className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <SheetTitle className="text-sm font-semibold text-white leading-tight">
                Lock In Capacity
              </SheetTitle>
              {lane && (
                <SheetDescription className="text-xs text-white/50 mt-0.5">
                  {laneLabel(lane)} · {lane.equipmentType ?? "Any Equipment"}
                </SheetDescription>
              )}
            </div>
          </div>

          {/* Lane stats */}
          {lane && (
            <div className="flex gap-3 mt-3 flex-wrap">
              <div className="flex flex-col">
                <span className="text-[10px] text-white/40 uppercase tracking-wide">Avg Loads/Week</span>
                <span className="text-sm font-semibold text-white">{lane.avgLoadsPerWeek ?? "—"}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-white/40 uppercase tracking-wide">Weeks Active</span>
                <span className="text-sm font-semibold text-white">{lane.weeksActive ?? "—"}/{lane.lookbackWeeks ?? 4}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-white/40 uppercase tracking-wide">Lane Score</span>
                <span className="text-sm font-semibold text-white">{lane.laneScore ?? "—"}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-white/40 uppercase tracking-wide">Confidence</span>
                <Badge variant="outline" className={`text-[10px] py-0 px-1.5 capitalize
                  ${lane.eligibilityConfidence === "high" ? "border-emerald-500/40 text-emerald-300" :
                    lane.eligibilityConfidence === "medium" ? "border-amber-500/40 text-amber-300" :
                    "border-slate-500/40 text-slate-300"}`}>
                  {lane.eligibilityConfidence}
                </Badge>
              </div>
            </div>
          )}

          {/* Outreach progress */}
          {lane && (
            <div className="mt-2">
              <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] text-white/40">Carriers Contacted</span>
                <span className="text-[10px] text-white/60">{contactedCount}/{completionThreshold}</span>
              </div>
              <div className="h-1.5 rounded-full bg-white/8">
                <div
                  className="h-1.5 rounded-full bg-amber-400 transition-all"
                  style={{ width: `${progressPct}%` }}
                  data-testid="outreach-progress-bar"
                />
              </div>
            </div>
          )}

          {/* Contactability warning — no carriers with phone/email */}
          {lane && bench.length > 0 && bench.every(b => !b.isContactable) && (
            <div className="mt-2 flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-md px-3 py-2"
              data-testid="no-contactable-carriers-warning">
              <AlertCircle className="w-3.5 h-3.5 text-orange-400 shrink-0" />
              <p className="text-[11px] text-orange-300">
                No carriers on this bench have a phone or email on file.
                Add contact details in the Carriers catalog to enable outreach.
              </p>
            </div>
          )}

          {/* Owner / Overseer chips */}
          {lane && (
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {/* Unassigned state — show assign button for managers */}
              {!lane.ownerUserId && isManager && (
                <div className="flex items-center gap-1.5" data-testid="chip-lane-unassigned">
                  <span className="text-[11px] text-white/30 italic">No owner assigned</span>
                  {currentUser && (
                    <button
                      onClick={() => assignLaneMutation.mutate(currentUser.id)}
                      disabled={assignLaneMutation.isPending}
                      className="text-[10px] px-2 py-0.5 rounded-full border border-blue-400/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 transition-colors"
                      data-testid="btn-assign-to-me"
                    >
                      {assignLaneMutation.isPending ? "Assigning…" : "Assign to me"}
                    </button>
                  )}
                  {isDirectorOrAdmin && (
                    <Select onValueChange={v => assignLaneMutation.mutate(v)}>
                      <SelectTrigger className="h-6 w-auto text-[10px] bg-white/5 border-white/10 text-white/50" data-testid="btn-assign-select">
                        <SelectValue placeholder="Assign to…" />
                      </SelectTrigger>
                      <SelectContent>
                        {teamMembers.map(m => (
                          <SelectItem key={m.id} value={m.id}>{m.name} ({m.role})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}
              {lane.ownerUserId && (() => {
                const owner = teamMembers.find(m => m.id === lane.ownerUserId);
                return (
                  <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-full px-2 py-0.5"
                    data-testid="chip-lane-owner">
                    <User className="w-3 h-3 text-blue-300" />
                    <span className="text-[11px] text-white/70">Owner: {owner?.name ?? lane.ownerUserId}</span>
                    {isDirectorOrAdmin && (
                      <Select
                        value={lane.ownerUserId}
                        onValueChange={v => reassignMutation.mutate({ ownerUserId: v })}
                      >
                        <SelectTrigger className="h-4 w-4 p-0 border-0 bg-transparent text-white/40 hover:text-white/80"
                          data-testid="btn-reassign-owner">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {teamMembers.map(m => (
                            <SelectItem key={m.id} value={m.id}>{m.name} ({m.role})</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                );
              })()}
              {lane.overseerUserId && lane.overseerUserId !== lane.ownerUserId && (() => {
                const overseer = teamMembers.find(m => m.id === lane.overseerUserId);
                return (
                  <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-full px-2 py-0.5"
                    data-testid="chip-lane-overseer">
                    <UserCheck className="w-3 h-3 text-violet-300" />
                    <span className="text-[11px] text-white/70">Overseer: {overseer?.name ?? lane.overseerUserId}</span>
                    {isDirectorOrAdmin && (
                      <Select
                        value={lane.overseerUserId ?? ""}
                        onValueChange={v => reassignMutation.mutate({ overseerUserId: v })}
                      >
                        <SelectTrigger className="h-4 w-4 p-0 border-0 bg-transparent text-white/40 hover:text-white/80"
                          data-testid="btn-reassign-overseer">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {teamMembers.map(m => (
                            <SelectItem key={m.id} value={m.id}>{m.name} ({m.role})</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Mode selector */}
          <div className="flex items-center gap-2 mt-3">
            <span className="text-[10px] text-white/40 shrink-0">Outreach Mode:</span>
            <Select
              value={outreachMode}
              onValueChange={(v: "lane_building" | "immediate_plus_lane") => setOutreachMode(v)}
            >
              <SelectTrigger
                className="h-7 text-xs bg-white/5 border-white/10 text-white/80 flex-1"
                data-testid="outreach-mode-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-white/10 text-white">
                <SelectItem value="lane_building" className="text-xs">Lane-Building (recurring framing)</SelectItem>
                <SelectItem value="immediate_plus_lane" className="text-xs">Immediate Load + Lane Building</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </SheetHeader>

        {/* Body */}
        <Tabs defaultValue="carriers" className="flex flex-col flex-1">
          <TabsList className="w-full rounded-none bg-white/4 border-b border-white/8 h-9 px-5 gap-0 justify-start">
            <TabsTrigger value="carriers" className="text-xs h-full rounded-none px-3 data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-amber-400 data-[state=active]:text-white" data-testid="tab-carriers">
              Carrier Suggestions
            </TabsTrigger>
            <TabsTrigger value="bench" className="text-xs h-full rounded-none px-3 data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-amber-400 data-[state=active]:text-white" data-testid="tab-bench">
              Bench {bench.length > 0 ? `(${bench.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="followup" className="text-xs h-full rounded-none px-3 data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-amber-400 data-[state=active]:text-white" data-testid="tab-followup">
              Follow-up
            </TabsTrigger>
          </TabsList>

          {/* ── Carrier Suggestions Tab ─────────────────────────────────── */}
          <TabsContent value="carriers" className="flex-1 px-5 pt-4 pb-20 overflow-y-auto">
            {/* Filter toggles */}
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <button
                onClick={() => setActiveOnly(v => !v)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  activeOnly ? "bg-blue-500/20 border-blue-400/40 text-blue-300" : "bg-white/4 border-white/10 text-white/40 hover:border-white/20"
                }`}
                data-testid="toggle-active-90-days"
              >
                Active (90 days)
              </button>
              <button
                onClick={() => setExcludeServiceFlags(v => !v)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  excludeServiceFlags ? "bg-red-500/20 border-red-400/40 text-red-300" : "bg-white/4 border-white/10 text-white/40 hover:border-white/20"
                }`}
                data-testid="toggle-exclude-service-flags"
              >
                Exclude Flagged
              </button>
              {(activeOnly || excludeServiceFlags) && rankedCarriers.length !== filteredCarriers.length && (
                <span className="text-[10px] text-white/30">{filteredCarriers.length}/{rankedCarriers.length} shown</span>
              )}
            </div>

            {suggestionsLoading && (
              <div className="flex items-center gap-2 text-white/40 text-xs py-4">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading carrier suggestions…
              </div>
            )}

            {!suggestionsLoading && filteredCarriers.length === 0 && (
              <div className="text-xs text-white/40 py-4">
                {rankedCarriers.length === 0
                  ? "No carriers in catalog yet. Add carriers in the Carriers admin tab to get AI rankings."
                  : "No carriers match the active filters."}
              </div>
            )}

            <div className="flex flex-col gap-2">
              {filteredCarriers.map((c, idx) => {
                const key = c.carrierId ?? c.carrierName;
                const isSelected = selectedCarriers.has(key);
                return (
                  <div key={key} className="flex flex-col">
                    <button
                      onClick={() => toggleCarrier(c)}
                      className={`text-left p-3 rounded-lg border transition-colors ${
                        isSelected
                          ? "bg-amber-500/10 border-amber-500/30"
                          : "bg-white/3 border-white/8 hover:bg-white/6"
                      }`}
                      data-testid={`carrier-suggestion-${idx}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-semibold text-white truncate">{c.carrierName}</span>
                            {c.isNewProspect && (
                              <Badge variant="outline" className="text-[9px] py-0 px-1 border-slate-500/40 text-slate-400">New Prospect</Badge>
                            )}
                            <Badge variant="outline" className="text-[9px] py-0 px-1 border-white/15 text-white/40">
                              {HISTORY_MATCH_LABELS[c.historyMatch] ?? c.historyMatch}
                            </Badge>
                            {!c.primaryEmail && !capturedEmails[c.carrierId ?? c.carrierName] && (
                              <Badge variant="outline" className="text-[9px] py-0 px-1 border-orange-500/40 text-orange-400 flex items-center gap-0.5">
                                <Mail className="w-2.5 h-2.5" />
                                No email on file
                              </Badge>
                            )}
                          </div>
                          <p className="text-[10px] text-white/50 mt-0.5 line-clamp-2">{c.fitReason}</p>
                          {(c.regions.length > 0 || c.equipmentTypes.length > 0) && (
                            <p className="text-[10px] text-white/30 mt-0.5">
                              {[...c.regions, ...c.equipmentTypes].slice(0, 4).join(" · ")}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-col items-end shrink-0">
                          <div className={`text-xs font-bold ${c.fitScore >= 70 ? "text-emerald-400" : c.fitScore >= 45 ? "text-amber-400" : "text-white/50"}`}>
                            {c.fitScore}
                          </div>
                          <div className="text-[9px] text-white/30">fit</div>
                          {isSelected && (
                            <CheckCircle2 className="w-3.5 h-3.5 text-amber-400 mt-1" />
                          )}
                        </div>
                      </div>
                    </button>
                    {/* Inline email affordances — shown when carrier is selected */}
                    {isSelected && (
                      <div className="ml-3 mr-0 -mt-1 bg-amber-500/5 border border-amber-500/15 border-t-0 rounded-b-lg px-3 pb-2 pt-2 flex flex-col gap-2">
                        {/* Add email capture when no email on file */}
                        {!c.primaryEmail && (
                          <div>
                            <p className="text-[9px] text-orange-400/70 mb-1 uppercase tracking-wide flex items-center gap-1">
                              <Mail className="w-2.5 h-2.5" />
                              Add carrier email
                            </p>
                            <input
                              type="email"
                              value={capturedEmails[key] ?? ""}
                              onChange={e => setCapturedEmails(prev => ({ ...prev, [key]: e.target.value }))}
                              placeholder={`email@${c.carrierName.toLowerCase().replace(/\s+/g, "")}.com`}
                              className="w-full text-[11px] text-white/70 bg-white/5 border border-white/10 rounded px-2 py-1 placeholder:text-white/20 focus:outline-none focus:border-orange-400/40"
                              data-testid={`add-email-input-${idx}`}
                            />
                          </div>
                        )}
                        <div>
                          <p className="text-[9px] text-amber-300/60 mb-1 uppercase tracking-wide">Custom email note (optional)</p>
                          <Textarea
                            value={inlineEmails[key] ?? ""}
                            onChange={e => setInlineEmails(prev => ({ ...prev, [key]: e.target.value }))}
                            placeholder={`Add a personalized note for ${c.carrierName}…`}
                            className="text-[11px] text-white/70 bg-white/5 border-white/10 resize-none min-h-[60px] placeholder:text-white/20"
                            data-testid={`inline-email-${idx}`}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Shared Template Editor — shown when carriers are selected */}
            {selectedCarriers.size > 0 && (
              <div className="mt-4 bg-slate-800/60 rounded-lg border border-white/8 p-3">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[10px] font-semibold text-white/70 uppercase tracking-wide">
                    Shared Template (applies to all selected carriers)
                  </p>
                  {sharedTemplate.trim() && (
                    <button
                      onClick={() => setSharedTemplate("")}
                      className="text-[9px] text-white/30 hover:text-white/50"
                      data-testid="clear-shared-template"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <p className="text-[9px] text-white/30 mb-1.5">
                  Enter a shared body for all selected carriers. Leave blank to let AI draft individual emails.
                </p>
                <Textarea
                  value={sharedTemplate}
                  onChange={e => setSharedTemplate(e.target.value)}
                  placeholder={`Hi [Carrier Name], I wanted to reach out about a recurring lane we run consistently…`}
                  className="text-[11px] text-white/70 bg-white/5 border-white/10 resize-none min-h-[80px] placeholder:text-white/20"
                  data-testid="shared-template-editor"
                />
                {sharedTemplate.trim() && (
                  <p className="text-[9px] text-emerald-400/70 mt-1 flex items-center gap-1">
                    <CheckCircle2 className="w-2.5 h-2.5" />
                    This template will be applied to {selectedCarriers.size} carrier(s) instead of AI drafting
                  </p>
                )}
              </div>
            )}

            {/* Email Drafts Section */}
            {showEmails && emailDrafts.length > 0 && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-white/80">Drafted Emails</p>
                  <button
                    onClick={() => setShowEmails(false)}
                    className="text-[10px] text-white/30 hover:text-white/60"
                  >
                    Hide
                  </button>
                </div>
                <div className="flex flex-col gap-3">
                  {emailDrafts.map((draft, i) => (
                    <div key={i} className="bg-white/4 rounded-lg border border-white/8 p-3">
                      <p className="text-[10px] font-semibold text-amber-300 mb-1">{draft.carrierName}</p>
                      <p className="text-[10px] text-white/50 mb-1"><span className="text-white/30">Subject:</span> {draft.subject}</p>
                      <Textarea
                        value={draft.body}
                        onChange={e => setEmailDrafts(prev => {
                          const next = [...prev];
                          next[i] = { ...next[i], body: e.target.value };
                          return next;
                        })}
                        className="text-[11px] text-white/70 bg-white/5 border-white/10 resize-none min-h-[100px]"
                        data-testid={`email-draft-${i}`}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>

          {/* ── Bench Tab ───────────────────────────────────────────────── */}
          <TabsContent value="bench" className="flex-1 px-5 pt-4 pb-20 overflow-y-auto">
            {bench.length === 0 ? (
              <p className="text-xs text-white/40 py-4">
                No carriers tracked yet. Select carriers from the Suggestions tab and mark them as contacted.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {/* Historical carrier callout */}
                {(() => {
                  const historicalMissingContact = bench.filter(b => b.sourceType === "historical" && !b.isContactable);
                  if (historicalMissingContact.length === 0) return null;
                  return (
                    <div className="bg-blue-500/8 border border-blue-500/20 rounded-lg p-3 flex items-start gap-2 mb-1"
                      data-testid="historical-carriers-callout">
                      <Truck className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-[11px] font-semibold text-blue-300">
                          {historicalMissingContact.length} historical carrier{historicalMissingContact.length > 1 ? "s" : ""} missing contact info
                        </p>
                        <p className="text-[10px] text-blue-300/60 mt-0.5">
                          These carriers have hauled this lane before. Add their phone or email in the Carrier catalog to enable outreach.
                        </p>
                        <p className="text-[10px] text-white/40 mt-1">{historicalMissingContact.map(b => b.carrierName).join(", ")}</p>
                      </div>
                    </div>
                  );
                })()}

                {bench.map(interest => {
                  const statusConfig = INTEREST_STATUS_LABELS[interest.interestStatus] ?? INTEREST_STATUS_LABELS.needs_follow_up;
                  const isExpanded = expandedReply === interest.id;
                  return (
                    <div
                      key={interest.id}
                      className="bg-white/4 rounded-lg border border-white/8 p-3"
                      data-testid={`bench-item-${interest.id}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                          <p className="text-xs font-semibold text-white truncate">{interest.carrierName}</p>
                          {interest.sourceType === "historical" && (
                            <Badge variant="outline" className="text-[9px] py-0 px-1 border-blue-500/30 text-blue-400">
                              Ran this lane
                            </Badge>
                          )}
                          {!interest.isContactable && (
                            <Badge variant="outline" className="text-[9px] py-0 px-1 border-orange-500/30 text-orange-400 flex items-center gap-0.5">
                              <Mail className="w-2.5 h-2.5" />
                              No contact info
                            </Badge>
                          )}
                          </div>
                          {interest.outreachSentAt && (
                            <p className="text-[10px] text-white/30 mt-0.5">
                              Contacted {new Date(interest.outreachSentAt).toLocaleDateString()}
                            </p>
                          )}
                          {interest.lastReplySnippet && (
                            <p className="text-[10px] text-white/50 italic mt-0.5 line-clamp-2">
                              "{interest.lastReplySnippet}"
                            </p>
                          )}
                        </div>
                        <Badge variant="outline" className={`text-[9px] py-0 px-1.5 shrink-0 ${statusConfig.color}`}>
                          {statusConfig.label}
                        </Badge>
                      </div>

                      {/* Manual interest status override */}
                      <div className="mt-2 flex flex-wrap gap-1">
                        {([
                          { value: "available_now", label: "Avail. Now" },
                          { value: "available_next_week", label: "Next Wk" },
                          { value: "future_interest", label: "Future" },
                          { value: "not_fit", label: "Not a Fit" },
                        ] as const).map(opt => (
                          <button
                            key={opt.value}
                            onClick={() => setInterestStatusMutation.mutate({
                              carrierId: interest.carrierId ?? null,
                              carrierName: interest.carrierName,
                              interestStatus: opt.value,
                            })}
                            disabled={setInterestStatusMutation.isPending}
                            className={`text-[9px] px-1.5 py-0.5 rounded border transition-colors ${
                              interest.interestStatus === opt.value
                                ? "border-blue-400/60 bg-blue-500/20 text-blue-300"
                                : "border-white/10 bg-white/5 text-white/30 hover:text-white/60 hover:border-white/20"
                            }`}
                            data-testid={`status-${opt.value}-${interest.id}`}
                          >
                            {opt.value === interest.interestStatus ? "✓ " : ""}{opt.label}
                          </button>
                        ))}
                      </div>

                      {/* Reply classify toggle */}
                      <button
                        onClick={() => setExpandedReply(isExpanded ? null : interest.id)}
                        className="mt-2 flex items-center gap-1 text-[10px] text-white/30 hover:text-white/60"
                        data-testid={`classify-toggle-${interest.id}`}
                      >
                        <Mail className="w-3 h-3" />
                        Classify reply
                        {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      </button>

                      {isExpanded && (
                        <div className="mt-2 flex flex-col gap-2">
                          <Textarea
                            placeholder="Paste carrier reply here…"
                            value={replyInputs[interest.id] ?? ""}
                            onChange={e => setReplyInputs(prev => ({ ...prev, [interest.id]: e.target.value }))}
                            className="text-[11px] text-white/70 bg-white/5 border-white/10 resize-none min-h-[60px]"
                            data-testid={`reply-input-${interest.id}`}
                          />
                          <Button
                            size="sm"
                            onClick={() => handleClassifyReply(interest)}
                            disabled={classifyReplyMutation.isPending || !(replyInputs[interest.id] ?? "").trim()}
                            className="h-7 text-xs bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 self-end"
                            data-testid={`classify-submit-${interest.id}`}
                          >
                            {classifyReplyMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Classify"}
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* ── Follow-up Tab ────────────────────────────────────────────── */}
          <TabsContent value="followup" className="flex-1 px-5 pt-4 pb-20 overflow-y-auto">
            {followupLoading ? (
              <div className="flex items-center gap-2 text-white/40 text-xs py-4">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading suggestions…
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {(followupData?.suggestions ?? []).length === 0 && (
                  <p className="text-xs text-white/40 py-4">
                    No follow-up suggestions yet — contact some carriers first.
                  </p>
                )}
                {(followupData?.suggestions ?? []).map((s, i) => (
                  <div
                    key={i}
                    className={`p-3 rounded-lg border flex items-start gap-2 ${
                      s.priority === "high" ? "bg-amber-500/8 border-amber-500/20" :
                      s.priority === "medium" ? "bg-white/4 border-white/10" :
                      "bg-white/2 border-white/6"
                    }`}
                    data-testid={`followup-suggestion-${i}`}
                  >
                    <Lightbulb className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
                      s.priority === "high" ? "text-amber-400" :
                      s.priority === "medium" ? "text-white/50" : "text-white/30"
                    }`} />
                    <p className="text-xs text-white/70">{s.message}</p>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>

        {/* Sticky action bar */}
        <div className="fixed bottom-0 right-0 w-full sm:max-w-xl bg-slate-900/95 backdrop-blur border-t border-white/8 px-5 py-3 flex gap-2 z-50">
          <Button
            variant="outline"
            size="sm"
            onClick={handleGenerateOutreach}
            disabled={selectedCarriers.size === 0 || draftEmailsMutation.isPending}
            className="flex-1 h-8 text-xs border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
            data-testid="btn-generate-outreach"
          >
            {draftEmailsMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Mail className="w-3 h-3 mr-1" />}
            Generate Carrier Outreach ({selectedCarriers.size})
          </Button>
          <Button
            size="sm"
            onClick={handleLogOutreach}
            disabled={selectedCarriers.size === 0 || outreachLogMutation.isPending}
            className="flex-1 h-8 text-xs bg-amber-500 hover:bg-amber-400 text-black font-semibold"
            data-testid="btn-mark-contacted"
          >
            {outreachLogMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
            Mark Contacted ({selectedCarriers.size})
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
