import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  FileSpreadsheet, Calendar, Trash2, Pencil, Trophy, Plus, Zap, ShieldAlert,
  ArrowRightLeft, ChevronDown, MapPin, Route, ShieldCheck, CheckCircle,
  AlertTriangle, UserPlus, Clock, List, PhoneCall,
} from "lucide-react";
import { TruckIcon } from "lucide-react";
import { ContactList } from "@/components/contact-list";
import { RfpDialog } from "@/components/rfp-dialog";
import { AwardDialog } from "@/components/award-dialog";
import { ConvertToAwardDialog } from "@/components/convert-to-award-dialog";
import { ResearchLaneDialog } from "@/components/research-lane-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Company, Contact, Rfp, Award, Touchpoint } from "@shared/schema";
import type { Facility, FacilityCoverage, LanePatterns, LaneMatching, ResearchTask, TaskWithCount } from "../types";

interface RfpTabProps {
  company: Company;
  companyId: string;
  companyRfps: Rfp[];
  companyAwards: Award[];
  contacts: Contact[] | undefined;
  companyTouchpoints: Touchpoint[];
  touchpointsThisMonth: number;
  rfpIntelDefaultTab: string;
  canReassign: boolean;
  handleEditContact: (c: Contact) => void;
  setViewContact: (v: Contact | null) => void;
  setTaskDialogOpen: (v: boolean) => void;
  setEditingTaskItem: (v: TaskWithCount | undefined) => void;
  setForceLanePrefill: (v: { title: string; notes?: string; attachedLaneData?: any[] } | undefined) => void;
  onCreateContactForFacility: (defaults: { lane?: string; region?: string }) => void;
}

export function RfpTab({
  company,
  companyId,
  companyRfps,
  companyAwards,
  contacts,
  companyTouchpoints,
  touchpointsThisMonth,
  rfpIntelDefaultTab,
  canReassign,
  handleEditContact,
  setViewContact,
  setTaskDialogOpen,
  setEditingTaskItem,
  setForceLanePrefill,
  onCreateContactForFacility,
}: RfpTabProps) {
  const { toast } = useToast();

  // ── Local UI state ────────────────────────────────────────────────────────
  const [rfpIntelCollapsed, setRfpIntelCollapsed] = useState(true);
  const [lanesCollapsed, setLanesCollapsed] = useState(true);
  const [laneGapInsights, setLaneGapInsights] = useState<Record<string, string>>({});

  // ── RFP / Award dialog state ──────────────────────────────────────────────
  const [cdRfpDialogOpen, setCdRfpDialogOpen] = useState(false);
  const [cdEditingRfp, setCdEditingRfp] = useState<Rfp | undefined>();
  const [cdAwardDialogOpen, setCdAwardDialogOpen] = useState(false);
  const [cdEditingAward, setCdEditingAward] = useState<Award | undefined>();
  const [cdConvertingRfp, setCdConvertingRfp] = useState<Rfp | null>(null);
  const [cdDeleteRfpTarget, setCdDeleteRfpTarget] = useState<Rfp | null>(null);
  const [cdDeleteAwardTarget, setCdDeleteAwardTarget] = useState<Award | null>(null);

  // ── Facility planner dialog state ─────────────────────────────────────────
  const [findPlannerFacilityKey, setFindPlannerFacilityKey] = useState<string | null>(null);
  const [assignExistingContactId, setAssignExistingContactId] = useState("");

  // ── Research lane dialog state ────────────────────────────────────────────
  const [selectedTask, setSelectedTask] = useState<ResearchTask | null>(null);
  const [researchDialogOpen, setResearchDialogOpen] = useState(false);

  // ── Queries ───────────────────────────────────────────────────────────────
  const { data: researchTasks } = useQuery<ResearchTask[]>({
    queryKey: ["/api/research-tasks", { companyId }],
    queryFn: async () => {
      const res = await fetch(`/api/research-tasks?companyId=${companyId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch research tasks");
      return res.json();
    },
  });

  const { data: facilityCoverage } = useQuery<FacilityCoverage>({
    queryKey: ["/api/companies", companyId, "facility-coverage"],
  });

  const findPlannerFacility = findPlannerFacilityKey
    ? (facilityCoverage?.facilities.find(
        (f) => `${f.fullName}|${f.type}` === findPlannerFacilityKey
      ) ?? null)
    : null;
  const setFindPlannerFacility = (f: Facility | null) =>
    setFindPlannerFacilityKey(f ? `${f.fullName}|${f.type}` : null);

  const { data: lanePatterns } = useQuery<LanePatterns>({
    queryKey: ["/api/companies", companyId, "lane-patterns"],
  });

  const { data: laneMatching } = useQuery<LaneMatching>({
    queryKey: ["/api/companies", companyId, "lane-matching"],
  });

  const { data: vendorRoutedKeys = [] } = useQuery<string[]>({
    queryKey: ["/api/companies", companyId, "vendor-routed"],
  });

  // ── Mutations ─────────────────────────────────────────────────────────────
  const vendorRoutedToggle = useMutation({
    mutationFn: async (rowKey: string) => {
      const res = await apiRequest("POST", `/api/companies/${companyId}/vendor-routed/toggle`, { rowKey });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "vendor-routed"] });
    },
  });

  const laneGapInsightsMutation = useMutation({
    mutationFn: async (corridors: Array<{ lane: string; totalVolume: number; originState?: string; destinationState?: string }>) => {
      const res = await apiRequest("POST", `/api/companies/${companyId}/lane-gap-insights`, { corridors });
      return res.json() as Promise<{ insights: Array<{ lane: string; talkingPoint: string }> }>;
    },
    onSuccess: (data) => {
      const map: Record<string, string> = {};
      for (const item of data.insights) map[item.lane] = item.talkingPoint;
      setLaneGapInsights(map);
    },
  });

  const markResearchedMutation = useMutation({
    mutationFn: async (task: ResearchTask) => {
      await apiRequest("PATCH", `/api/rfps/${task.rfpId}/lanes/${task.laneIndex}/status`, { status: "researched" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/research-tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/rfps"] });
      toast({ title: "Lane marked as researched", className: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800" });
    },
  });

  const assignContactToFacilityMutation = useMutation({
    mutationFn: async ({ contactId, laneToAdd }: { contactId: string; laneToAdd: string }) => {
      const contact = contacts?.find(c => c.id === contactId);
      if (!contact) throw new Error("Contact not found");
      const existingLanes: string[] = contact.lanes || [];
      if (!existingLanes.includes(laneToAdd)) {
        await apiRequest("PATCH", `/api/contacts/${contactId}`, {
          ...contact,
          lanes: [...existingLanes, laneToAdd],
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "facility-coverage"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "contacts"] });
      setAssignExistingContactId("");
      toast({ title: "Contact assigned to facility", className: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800" });
    },
    onError: (error: Error) => {
      toast({ title: "Error assigning contact", description: error.message, variant: "destructive" });
    },
  });

  const removeContactFromFacilityMutation = useMutation({
    mutationFn: async ({ contactId, laneToRemove }: { contactId: string; laneToRemove: string }) => {
      const contact = contacts?.find(c => c.id === contactId);
      if (!contact) throw new Error("Contact not found");
      const updatedLanes = (contact.lanes || []).filter(
        (l) => l.toLowerCase().trim() !== laneToRemove.toLowerCase().trim()
      );
      await apiRequest("PATCH", `/api/contacts/${contactId}`, {
        ...contact,
        lanes: updatedLanes,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "facility-coverage"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "contacts"] });
      toast({ title: "Contact removed from facility", className: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800" });
    },
    onError: (error: Error) => {
      toast({ title: "Error removing contact", description: error.message, variant: "destructive" });
    },
  });

  const cdDeleteRfpMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/rfps/${id}`); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rfps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      toast({ title: "RFP deleted" });
      setCdDeleteRfpTarget(null);
    },
    onError: (error: Error) => toast({ title: "Error deleting RFP", description: error.message, variant: "destructive" }),
  });

  const cdDeleteAwardMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/awards/${id}`); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/awards"] });
      toast({ title: "Award deleted" });
      setCdDeleteAwardTarget(null);
    },
    onError: (error: Error) => toast({ title: "Error deleting award", description: error.message, variant: "destructive" }),
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  const handleAssignTask = (task: ResearchTask) => {
    setSelectedTask(task);
    setResearchDialogOpen(true);
  };

  const validLoc = (s: string) => !!s && s.trim().toUpperCase() !== "N/A" && s.trim() !== "";
  const openTasks = researchTasks?.filter(t => t.status === "open") || [];

  return (
    <>
      {/* ── RFP Management ─────────────────────────────────────────────────────── */}
      <Card data-testid="card-rfp-management">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">RFPs</CardTitle>
              {companyRfps.length > 0 && (
                <Badge variant="secondary">{companyRfps.length}</Badge>
              )}
            </div>
            <Button
              size="sm"
              onClick={() => { setCdEditingRfp(undefined); setCdRfpDialogOpen(true); }}
              data-testid="button-add-rfp-cd"
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add RFP
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {companyRfps.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-muted-foreground">No RFPs yet for this account.</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => { setCdEditingRfp(undefined); setCdRfpDialogOpen(true); }}
                data-testid="button-add-first-rfp-cd"
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add First RFP
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {companyRfps.map(rfp => {
                const statusMap: Record<string, { label: string; color: string }> = {
                  pending: { label: "Pending", color: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400" },
                  submitted: { label: "Submitted", color: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
                  awarded: { label: "Awarded", color: "bg-green-500/10 text-green-600 dark:text-green-400" },
                  partially_awarded: { label: "Partial Award", color: "bg-teal-500/10 text-teal-600 dark:text-teal-400" },
                  lost: { label: "Lost", color: "bg-red-500/10 text-red-600 dark:text-red-400" },
                  declined: { label: "Declined", color: "bg-gray-500/10 text-gray-600 dark:text-gray-400" },
                };
                const st = statusMap[rfp.status] ?? { label: rfp.status, color: "bg-gray-500/10 text-gray-600" };
                return (
                  <div key={rfp.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0" data-testid={`row-rfp-${rfp.id}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium truncate">{rfp.title}</span>
                        <Badge className={`${st.color} text-[10px] px-1.5 py-0 h-4 shrink-0`}>{st.label}</Badge>
                        {rfp.rfpType && (
                          <span className="text-[10px] text-muted-foreground shrink-0 capitalize">{rfp.rfpType.replace("_", " ")}</span>
                        )}
                      </div>
                      {rfp.dueDate && (
                        <div className="flex items-center gap-1 mt-0.5">
                          <Calendar className="h-3 w-3 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground">Due {rfp.dueDate}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      {rfp.status !== "awarded" && rfp.status !== "partially_awarded" && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                          title="Mark as Won"
                          onClick={() => setCdConvertingRfp(rfp)}
                          data-testid={`button-convert-rfp-cd-${rfp.id}`}
                        >
                          <Trophy className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        title="Edit"
                        onClick={() => { setCdEditingRfp(rfp); setCdRfpDialogOpen(true); }}
                        data-testid={`button-edit-rfp-cd-${rfp.id}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        title="Delete"
                        onClick={() => setCdDeleteRfpTarget(rfp)}
                        data-testid={`button-delete-rfp-cd-${rfp.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Awards Management ──────────────────────────────────────────────────── */}
      <Card data-testid="card-awards-management">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Trophy className="h-4 w-4 text-amber-500" />
              <CardTitle className="text-base">Awards</CardTitle>
              {companyAwards.length > 0 && (
                <Badge variant="secondary">{companyAwards.length}</Badge>
              )}
            </div>
            <Button
              size="sm"
              onClick={() => { setCdEditingAward(undefined); setCdAwardDialogOpen(true); }}
              data-testid="button-add-award-cd"
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add Award
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {companyAwards.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-muted-foreground">No awards on file for this account.</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => { setCdEditingAward(undefined); setCdAwardDialogOpen(true); }}
                data-testid="button-add-first-award-cd"
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add First Award
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {companyAwards.map(award => (
                <div key={award.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0" data-testid={`row-award-${award.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">{award.title}</span>
                      {award.value && parseFloat(award.value) > 0 && (
                        <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium shrink-0">
                          ${parseFloat(award.value).toLocaleString()}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      {award.awardDate && (
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3 w-3 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground">{award.awardDate}</span>
                        </div>
                      )}
                      {award.lanes && award.lanes.length > 0 && (
                        <span className="text-xs text-muted-foreground">{award.lanes.length} lane{award.lanes.length !== 1 ? "s" : ""}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      title="Edit"
                      onClick={() => { setCdEditingAward(award); setCdAwardDialogOpen(true); }}
                      data-testid={`button-edit-award-cd-${award.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      title="Delete"
                      onClick={() => setCdDeleteAwardTarget(award)}
                      data-testid={`button-delete-award-cd-${award.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── RFP Intelligence ────────────────────────────────────────────────────── */}
      {(facilityCoverage !== undefined || lanePatterns !== undefined || laneMatching !== undefined) && (() => {
        const gapCount = facilityCoverage?.summary.gaps ?? 0;
        const closeMatchCount =
          (laneMatching?.ourDeliveriesToTheirPickups.filter(m => m.distance < 10).length ?? 0) +
          (laneMatching?.theirDeliveriesToOurPickups.filter(m => m.distance < 10).length ?? 0);
        const matchCount = (laneMatching?.ourDeliveriesToTheirPickups.length ?? 0) + (laneMatching?.theirDeliveriesToOurPickups.length ?? 0);
        const corridorCount = lanePatterns?.topCorridors.filter(c =>
          (validLoc(c.origin) || validLoc(c.originState)) && (validLoc(c.destination) || validLoc(c.destinationState))
        ).length ?? 0;
        const hasAnyData =
          (facilityCoverage?.facilities.length ?? 0) > 0 ||
          (lanePatterns && (lanePatterns.topCorridors.length > 0 || lanePatterns.hubs.length > 0 || lanePatterns.stateCorridors.length > 0)) ||
          (laneMatching?.hasRfpData);

        return (
          <Card data-testid="card-rfp-intelligence">
            <CardHeader className="pb-3">
              <button
                onClick={() => setRfpIntelCollapsed(c => !c)}
                className="w-full flex items-center justify-between group"
                data-testid="btn-toggle-rfp-intel"
              >
                <div className="flex items-center gap-2">
                  <Zap className="h-5 w-5 text-yellow-500" />
                  <h2 className="text-base font-medium">RFP Intelligence</h2>
                </div>
                <div className="flex items-center gap-2">
                  {gapCount > 0 && (
                    <Badge className="bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400" data-testid="badge-coverage-gaps">
                      <ShieldAlert className="h-3 w-3 mr-1" />{gapCount} gap{gapCount !== 1 ? "s" : ""}
                    </Badge>
                  )}
                  {matchCount > 0 && (
                    <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400">
                      <ArrowRightLeft className="h-3 w-3 mr-1" />
                      {closeMatchCount > 0 ? `${closeMatchCount} close` : "matches"}
                    </Badge>
                  )}
                  {corridorCount > 0 && (
                    <Badge variant="secondary">{corridorCount} corridor{corridorCount !== 1 ? "s" : ""}</Badge>
                  )}
                  <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${rfpIntelCollapsed ? "-rotate-90" : ""}`} />
                </div>
              </button>
            </CardHeader>
            {!rfpIntelCollapsed && (
              <CardContent className="pt-0">
                {!hasAnyData ? (
                  <div className="py-10 text-center space-y-3">
                    <Route className="h-10 w-10 mx-auto text-muted-foreground/30" />
                    <p className="text-sm font-medium text-foreground">No RFP data for this account yet</p>
                    <p className="text-xs text-muted-foreground">Upload an RFP to unlock coverage gaps, lane patterns, and matching opportunities.</p>
                    <a href="/rfp-awards" className="text-xs text-primary underline underline-offset-2 hover:opacity-80">Go to RFP & Awards →</a>
                  </div>
                ) : (
                  <Tabs defaultValue={rfpIntelDefaultTab} className="w-full">
                    <TabsList className="w-full grid grid-cols-3 mb-4">
                      <TabsTrigger value="coverage" data-testid="tab-coverage">
                        <MapPin className="h-3.5 w-3.5 mr-1.5" />
                        Coverage
                        {gapCount > 0 && <span className="ml-1.5 text-[10px] bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400 px-1.5 py-0 rounded-full font-medium">{gapCount}</span>}
                      </TabsTrigger>
                      <TabsTrigger value="patterns" data-testid="tab-patterns">
                        <Route className="h-3.5 w-3.5 mr-1.5" />
                        Lane Patterns
                      </TabsTrigger>
                      <TabsTrigger value="matching" data-testid="tab-matching">
                        <ArrowRightLeft className="h-3.5 w-3.5 mr-1.5" />
                        Lane Matching
                        {matchCount > 0 && <span className="ml-1.5 text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400 px-1.5 py-0 rounded-full font-medium">{matchCount}</span>}
                      </TabsTrigger>
                    </TabsList>

                    {/* ── Coverage Tab ────────────────────────────────── */}
                    <TabsContent value="coverage" className="mt-0">
                      {!facilityCoverage || facilityCoverage.facilities.length === 0 ? (
                        <div className="py-8 text-center space-y-2">
                          <p className="text-sm text-muted-foreground">No facility coverage data. Upload an RFP to see which facilities need contacts.</p>
                          <a href="/rfp-awards" className="text-xs text-primary underline underline-offset-2">Go to RFP & Awards →</a>
                        </div>
                      ) : (() => {
                        const gaps = facilityCoverage.facilities
                          .filter(f => !f.covered && !vendorRoutedKeys.includes(`facility:${f.fullName}:${f.type}`))
                          .sort((a, b) => b.totalVolume - a.totalVolume);
                        const covered = facilityCoverage.facilities
                          .filter(f => f.covered)
                          .sort((a, b) => b.totalVolume - a.totalVolume);
                        const handledFacilities = facilityCoverage.facilities
                          .filter(f => !f.covered && vendorRoutedKeys.includes(`facility:${f.fullName}:${f.type}`));
                        return (
                          <div className="space-y-3">
                            {gaps.length > 0 && (
                              <div className="rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200/60 dark:border-red-800/30 px-4 py-2.5 flex items-start gap-3">
                                <ShieldAlert className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                                <div className="text-sm">
                                  <span className="font-medium text-red-700 dark:text-red-300">{gaps.length} facilit{gaps.length !== 1 ? "ies" : "y"} need{gaps.length === 1 ? "s" : ""} a contact</span>
                                  {gaps[0] && <span className="text-red-600/70 dark:text-red-400/70 ml-1.5">· Highest priority: <span className="font-medium">{gaps[0].fullName}</span> ({gaps[0].totalVolume.toLocaleString()} loads/yr)</span>}
                                </div>
                              </div>
                            )}
                            {gaps.length === 0 && covered.length > 0 && (
                              <div className="rounded-lg bg-green-50 dark:bg-green-950/20 border border-green-200/60 dark:border-green-800/30 px-4 py-2.5 flex items-center gap-3">
                                <ShieldCheck className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
                                <span className="text-sm font-medium text-green-700 dark:text-green-300">All facilities covered — great work!</span>
                              </div>
                            )}
                            {gaps.length > 0 && (
                              <div className="space-y-1.5">
                                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Needs Coverage ({gaps.length})</p>
                                {gaps.map((f, i) => (
                                  <div key={`${f.fullName}-${f.type}-${i}`} className="flex items-center justify-between p-3 rounded-md border bg-red-50/50 border-red-200/50 dark:bg-red-950/20 dark:border-red-800/30" data-testid={`facility-gap-${i}`}>
                                    <div className="flex items-center gap-3 min-w-0 flex-1">
                                      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 shrink-0">
                                        <MapPin className="h-3.5 w-3.5" />
                                      </div>
                                      <div className="min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <p className="font-medium text-sm">{f.fullName}</p>
                                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">{f.type === "origin" ? "Origin" : "Dest"}</Badge>
                                        </div>
                                        <p className="text-xs text-muted-foreground mt-0.5">{f.totalVolume.toLocaleString()} loads/yr · {f.laneCount} lane{f.laneCount !== 1 ? "s" : ""}</p>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                      <Button size="sm" variant="outline" className="border-red-300 text-red-700 hover:bg-red-100 dark:border-red-700 dark:text-red-400 h-7 px-2 text-xs"
                                        onClick={() => { setAssignExistingContactId(""); setFindPlannerFacility(f); }}
                                        data-testid={`button-find-planner-${i}`}>
                                        <UserPlus className="h-3 w-3 mr-1" />Find Planner
                                      </Button>
                                      {canReassign && (
                                        <Button size="sm" variant="outline" className="border-indigo-300 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:text-indigo-400 h-7 px-2 text-xs"
                                          onClick={() => { setForceLanePrefill({ title: `Cover facility: ${f.fullName}`, notes: `Facility: ${f.fullName}\nType: ${f.type === "origin" ? "Origin" : "Destination"}\nVolume: ${f.totalVolume.toLocaleString()} loads/yr\nLanes: ${f.laneCount}`, attachedLaneData: [{ type: "action_required", label: "Facility Coverage Gap", items: [{ lane: f.fullName, volume: f.totalVolume }] }] }); setEditingTaskItem(undefined); setTaskDialogOpen(true); }}
                                          data-testid={`button-force-task-facility-${i}`}>
                                          <Zap className="h-3 w-3 mr-1" />Task
                                        </Button>
                                      )}
                                      <Button size="sm" variant="outline" disabled={vendorRoutedToggle.isPending}
                                        className={vendorRoutedKeys.includes(`facility:${f.fullName}:${f.type}`) ? "bg-green-500 text-white border-green-500 hover:bg-green-600 h-7 px-2 text-xs" : "border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 h-7 px-2 text-xs"}
                                        onClick={() => vendorRoutedToggle.mutate(`facility:${f.fullName}:${f.type}`)}
                                        data-testid={`button-vendor-routed-facility-${i}`}>
                                        <TruckIcon className="h-3 w-3 mr-1" />Handled
                                      </Button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                            {covered.length > 0 && (
                              <div className="space-y-1.5">
                                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Covered ({covered.length})</p>
                                {covered.map((f, i) => (
                                  <div key={`${f.fullName}-${f.type}-covered-${i}`} className="flex items-center justify-between p-2.5 rounded-md border bg-green-50/30 border-green-200/40 dark:bg-green-950/10 dark:border-green-800/20" data-testid={`facility-covered-${i}`}>
                                    <div className="flex items-center gap-3 min-w-0 flex-1">
                                      <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                                      <div className="min-w-0">
                                        <p className="font-medium text-sm">{f.fullName}</p>
                                        <p className="text-xs text-muted-foreground">{f.totalVolume.toLocaleString()} loads/yr{f.coveredBy && f.coveredBy.length > 0 ? ` · ${f.coveredBy.map(c => c.name).join(", ")}` : ""}</p>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                      <Badge className="bg-green-500/10 text-green-600 dark:text-green-400"><CheckCircle className="h-3 w-3 mr-1" />Covered</Badge>
                                      {f.coveredBy && f.coveredBy.length > 0 && (
                                        <Badge variant="secondary" className="text-xs">
                                          {f.coveredBy.length} {f.coveredBy.length === 1 ? "planner" : "planners"}
                                        </Badge>
                                      )}
                                      <Button size="sm" variant="default" className="h-7 px-2.5 text-xs bg-blue-600 hover:bg-blue-700 text-white"
                                        onClick={() => { setAssignExistingContactId(""); setFindPlannerFacility(f); }}
                                        data-testid={`button-manage-facility-${i}`}>
                                        Add/Remove Planners
                                      </Button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                            {handledFacilities.length > 0 && (
                              <details className="group">
                                <summary className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer list-none hover:text-foreground">
                                  <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                                  Vendor Routed ({handledFacilities.length})
                                </summary>
                                <div className="mt-2 space-y-1 opacity-60">
                                  {handledFacilities.map((f, i) => (
                                    <div key={i} className="flex items-center justify-between p-2 rounded-md border text-xs">
                                      <div className="flex items-center gap-2">
                                        <TruckIcon className="h-3 w-3 text-muted-foreground" />
                                        <span>{f.fullName}</span>
                                        <Badge variant="outline" className="text-[10px] px-1 py-0">{f.type === "origin" ? "Origin" : "Dest"}</Badge>
                                      </div>
                                      <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]"
                                        onClick={() => vendorRoutedToggle.mutate(`facility:${f.fullName}:${f.type}`)}>
                                        Undo
                                      </Button>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            )}
                          </div>
                        );
                      })()}
                    </TabsContent>

                    {/* ── Lane Patterns Tab ─────────────────────────── */}
                    <TabsContent value="patterns" className="mt-0">
                      {!lanePatterns || (lanePatterns.topCorridors.length === 0 && lanePatterns.hubs.length === 0 && lanePatterns.stateCorridors.length === 0) ? (
                        <p className="text-sm text-muted-foreground text-center py-8">No lane pattern data available for this account.</p>
                      ) : (() => {
                        const filteredCorridors = lanePatterns.topCorridors.filter(c =>
                          (validLoc(c.origin) || validLoc(c.originState)) && (validLoc(c.destination) || validLoc(c.destinationState))
                        );
                        const awardedRfpTitleSet = new Set(companyRfps.filter(r => r.status === "awarded" || r.status === "partially_awarded").map(r => r.title));
                        const maxVolume = Math.max(...filteredCorridors.map(c => c.totalVolume), 1);
                        const maxCount = Math.max(...filteredCorridors.map(c => c.count ?? 1), 1);
                        const withPriority = filteredCorridors.map(c => {
                          const volumeScore = (c.totalVolume / maxVolume) * 40;
                          const multiRfpScore = c.appearsInMultipleRfps ? 30 : 0;
                          const notAwardedScore = !c.rfpTitles.some(t => awardedRfpTitleSet.has(t)) ? 20 : 0;
                          const countScore = ((c.count ?? 1) / maxCount) * 10;
                          const priorityScore = Math.round(volumeScore + multiRfpScore + notAwardedScore + countScore);
                          const priorityLabel = priorityScore >= 70 ? "High" : priorityScore >= 40 ? "Medium" : "Low";
                          const priorityColor = priorityScore >= 70 ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" : priorityScore >= 40 ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" : "bg-gray-100 text-gray-600 dark:bg-gray-800/50 dark:text-gray-400";
                          return { ...c, priorityScore, priorityLabel, priorityColor };
                        }).sort((a, b) => b.priorityScore - a.priorityScore);
                        const topUnawarded = withPriority.filter(c => !c.rfpTitles.some(t => awardedRfpTitleSet.has(t))).slice(0, 3);
                        const top5 = withPriority.slice(0, 5);
                        const remaining = withPriority.length - 5;
                        return (
                          <div className="space-y-3">
                            {topUnawarded.length > 0 && (
                              <div className="rounded-md px-3 py-2.5 bg-amber-50/60 dark:bg-amber-950/15 border border-amber-200/50 dark:border-amber-800/30 text-xs space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="font-medium text-amber-700 dark:text-amber-400">Top unawarded corridors — priority to win:</p>
                                  <Button
                                    size="sm" variant="outline"
                                    className="h-6 px-2 text-[11px] border-amber-400 text-amber-700 hover:bg-amber-100 dark:border-amber-600 dark:text-amber-400 shrink-0"
                                    disabled={laneGapInsightsMutation.isPending}
                                    onClick={() => laneGapInsightsMutation.mutate(topUnawarded.map(c => ({ lane: c.lane, totalVolume: c.totalVolume, originState: c.originState, destinationState: c.destinationState })))}
                                    data-testid="button-generate-lane-insights"
                                  >
                                    {laneGapInsightsMutation.isPending ? "Generating…" : "✦ AI Talking Points"}
                                  </Button>
                                </div>
                                {topUnawarded.map((c, i) => (
                                  <div key={i} className="space-y-1">
                                    <p className="text-muted-foreground pl-1">· <span className="font-medium text-foreground">{c.lane}</span> ({c.totalVolume.toLocaleString()} loads/yr)</p>
                                    {laneGapInsights[c.lane] && (
                                      <div className="ml-3 flex items-start gap-2 rounded bg-white/60 dark:bg-white/5 border border-amber-200/60 dark:border-amber-800/20 px-2 py-1.5">
                                        <span className="text-amber-600 dark:text-amber-400 mt-0.5">💬</span>
                                        <p className="text-muted-foreground leading-relaxed flex-1">{laneGapInsights[c.lane]}</p>
                                        <button className="shrink-0 text-amber-600 dark:text-amber-400 hover:text-amber-800 transition-colors" title="Copy talking point" data-testid={`button-copy-lane-insight-${i}`} onClick={() => navigator.clipboard.writeText(laneGapInsights[c.lane])}>
                                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                            <div className="space-y-1.5">
                              {top5.map((c, i) => (
                                <div key={i} className={`flex items-center justify-between px-3 py-2 rounded-md border bg-background hover:bg-muted/40 transition-colors ${c.rfpTitles.some(t => awardedRfpTitleSet.has(t)) ? "border-green-300 dark:border-green-700/60 bg-green-50/20 dark:bg-green-950/10" : c.appearsInMultipleRfps ? "border-blue-200 dark:border-blue-800/40" : ""}`} data-testid={`corridor-${i}`}>
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-sm font-medium truncate">{c.lane}</span>
                                    <span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0 rounded-full shrink-0 ${c.priorityColor}`}>{c.priorityLabel}</span>
                                    {c.rfpTitles.some(t => awardedRfpTitleSet.has(t)) && <span className="text-[10px] text-green-600 dark:text-green-400 font-medium shrink-0">✓ We Ship</span>}
                                  </div>
                                  <span className="text-xs text-muted-foreground shrink-0 ml-2">{c.totalVolume.toLocaleString()} loads/yr</span>
                                </div>
                              ))}
                            </div>
                            <a href="/rfp-awards" className="text-xs text-primary underline underline-offset-2 hover:opacity-80">
                              {remaining > 0 ? `View ${remaining} more corridor${remaining !== 1 ? "s" : ""} + hubs & state map in RFP & Awards →` : "View full lane analysis in RFP & Awards →"}
                            </a>
                          </div>
                        );
                      })()}
                    </TabsContent>

                    {/* ── Lane Matching Tab ─────────────────────────── */}
                    <TabsContent value="matching" className="mt-0">
                      {!laneMatching ? (
                        <p className="text-sm text-muted-foreground text-center py-8">Loading lane matching data…</p>
                      ) : !laneMatching.hasHistoricalData ? (
                        <div className="py-8 text-center space-y-2">
                          <p className="text-sm text-muted-foreground">No historical dispatch data uploaded yet.</p>
                          <a href="/historical" className="text-xs text-primary underline underline-offset-2 hover:opacity-80">Go to Historical Data →</a>
                        </div>
                      ) : !laneMatching.hasRfpData ? (
                        <div className="py-8 text-center space-y-2">
                          <p className="text-sm text-muted-foreground">No RFP lane data for this company yet.</p>
                          <a href="/rfp-awards" className="text-xs text-primary underline underline-offset-2 hover:opacity-80">Go to RFP & Awards to upload →</a>
                        </div>
                      ) : (() => {
                        const closeDelivery = laneMatching.ourDeliveriesToTheirPickups.filter(m => m.distance < 10).length;
                        const closePickup = laneMatching.theirDeliveriesToOurPickups.filter(m => m.distance < 10).length;
                        const totalDelivery = laneMatching.ourDeliveriesToTheirPickups.length;
                        const totalPickup = laneMatching.theirDeliveriesToOurPickups.length;
                        const closeTotal = closeDelivery + closePickup;
                        const grandTotal = totalDelivery + totalPickup;
                        return (
                          <div className="space-y-3">
                            {grandTotal === 0 ? (
                              <p className="text-sm text-muted-foreground text-center py-6">No lane matches found within 50 miles.</p>
                            ) : (
                              <div className="space-y-2">
                                {closeTotal > 0 && (
                                  <div className="flex items-start gap-3 rounded-md px-3 py-2.5 bg-green-50/60 dark:bg-green-950/20 border border-green-200/60 dark:border-green-800/30">
                                    <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
                                    <div>
                                      <p className="text-sm font-medium text-green-700 dark:text-green-300">{closeTotal} close match{closeTotal !== 1 ? "es" : ""} within 10 miles</p>
                                      <p className="text-xs text-muted-foreground mt-0.5">We already operate near their lanes — strong backhaul opportunities.</p>
                                    </div>
                                  </div>
                                )}
                                {grandTotal - closeTotal > 0 && (
                                  <div className="flex items-start gap-3 rounded-md px-3 py-2.5 bg-blue-50/60 dark:bg-blue-950/20 border border-blue-200/50 dark:border-blue-800/30">
                                    <ArrowRightLeft className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                                    <p className="text-sm text-blue-700 dark:text-blue-300">{grandTotal - closeTotal} additional match{grandTotal - closeTotal !== 1 ? "es" : ""} within 50 miles</p>
                                  </div>
                                )}
                              </div>
                            )}
                            <a href="/rfp-awards" className="text-xs text-primary underline underline-offset-2 hover:opacity-80">
                              View full lane matching analysis in RFP & Awards →
                            </a>
                          </div>
                        );
                      })()}
                    </TabsContent>
                  </Tabs>
                )}
              </CardContent>
            )}
          </Card>
        );
      })()}

      {/* Research Tasks */}
      {researchTasks && researchTasks.length > 0 && (() => {
        const hasLocation = (city: string, state: string) => {
          const valid = (s: string) => !!s && s.trim().toUpperCase() !== "N/A" && s.trim() !== "";
          return valid(city) || valid(state);
        };
        const unresolvedTasks = researchTasks.filter(t =>
          (t.status === "open" || t.status === "contact_added") &&
          hasLocation(t.origin, t.originState) &&
          hasLocation(t.destination, t.destinationState)
        );
        const completedTasks = researchTasks.filter(t => t.status === "researched");
        return (
          <Card className="border-2 border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20" data-testid="card-lanes-needing-contacts">
            <CardContent className="p-4">
              <button
                onClick={() => setLanesCollapsed(c => !c)}
                className="w-full flex items-center justify-between mb-3 group"
                data-testid="btn-toggle-lanes"
              >
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                  <h2 className="text-base font-medium text-amber-700 dark:text-amber-400">
                    High-Volume Lanes Needing Contacts
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  {completedTasks.length > 0 && (
                    <Badge className="bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400">
                      {completedTasks.length} done
                    </Badge>
                  )}
                  {openTasks.length > 0 && (
                    <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400">
                      {openTasks.length} open
                    </Badge>
                  )}
                  <ChevronDown className={`h-4 w-4 text-amber-600 dark:text-amber-400 transition-transform duration-200 ${lanesCollapsed ? "-rotate-90" : ""}`} />
                </div>
              </button>
              {!lanesCollapsed && (() => {
                const fmtLoc = (city: string, state: string) => {
                  if (!city && !state) return "—";
                  if (!city) return state;
                  if (!state) return city;
                  if (city.toUpperCase().includes(state.toUpperCase())) return city;
                  return `${city}, ${state}`;
                };
                const sorted = [...unresolvedTasks].sort((a, b) => b.volume - a.volume);
                const top5 = sorted.slice(0, 5);
                const hiddenCount = sorted.length - 5;
                if (unresolvedTasks.length === 0) {
                  return <p className="text-sm text-muted-foreground">All high-volume lanes have been researched.</p>;
                }
                const thClass = "text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide py-2 px-3 whitespace-nowrap";
                return (
                  <div className="space-y-2">
                    <div className="overflow-x-auto rounded-md border">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50 border-b">
                          <tr>
                            <th className={thClass}>Origin</th>
                            <th className={thClass}>Destination</th>
                            <th className={thClass}>Volume</th>
                            <th className={thClass}>Equipment</th>
                            <th className={thClass}>Status</th>
                            <th className={thClass}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {top5.map((task, i) => {
                            const linkedContact = task.contactId && contacts
                              ? contacts.find(c => c.id === task.contactId)
                              : null;
                            return (
                              <tr
                                key={`${task.rfpId}-${task.laneIndex}`}
                                className="border-b last:border-0 hover:bg-muted/40 transition-colors"
                                data-testid={`lane-task-${i}`}
                              >
                                <td className="py-2 px-3 font-medium">{fmtLoc(task.origin, task.originState)}</td>
                                <td className="py-2 px-3 font-medium">{fmtLoc(task.destination, task.destinationState)}</td>
                                <td className="py-2 px-3 text-muted-foreground whitespace-nowrap">{Math.round(task.volume).toLocaleString()} / yr</td>
                                <td className="py-2 px-3 text-muted-foreground">{task.equipment || "—"}</td>
                                <td className="py-2 px-3">
                                  {task.status === "open" ? (
                                    <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                                      <Clock className="h-3 w-3 mr-1" />Open
                                    </Badge>
                                  ) : (
                                    <Badge className="bg-blue-500/10 text-blue-600 dark:text-blue-400">
                                      <UserPlus className="h-3 w-3 mr-1" />Contact Added
                                    </Badge>
                                  )}
                                  {linkedContact && (
                                    <span className="ml-2 text-xs text-green-600 dark:text-green-400">{linkedContact.name}</span>
                                  )}
                                </td>
                                <td className="py-2 px-3 whitespace-nowrap">
                                  <div className="flex items-center gap-2">
                                    {task.status === "open" ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-400"
                                        onClick={() => handleAssignTask(task)}
                                        data-testid={`button-assign-lane-task-${i}`}
                                      >
                                        <UserPlus className="h-4 w-4 mr-1" />Assign
                                      </Button>
                                    ) : (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="border-green-300 text-green-700 hover:bg-green-100 dark:border-green-700 dark:text-green-400"
                                        onClick={() => markResearchedMutation.mutate(task)}
                                        disabled={markResearchedMutation.isPending}
                                        data-testid={`button-mark-complete-task-${i}`}
                                      >
                                        Mark Complete
                                      </Button>
                                    )}
                                    {canReassign && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="border-indigo-300 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:text-indigo-400"
                                        onClick={() => {
                                          const laneName = `${task.origin}${task.originState ? `, ${task.originState}` : ""} → ${task.destination}${task.destinationState ? `, ${task.destinationState}` : ""}`;
                                          setForceLanePrefill({
                                            title: `Research lane: ${laneName}`,
                                            notes: `RFP: ${task.rfpTitle}\nVolume: ${Math.round(task.volume).toLocaleString()} loads/yr${task.rate ? `\nRate: ${task.rate}` : ""}${task.equipment ? `\nEquipment: ${task.equipment}` : ""}`,
                                            attachedLaneData: [{
                                              type: "action_required",
                                              label: "Action Required Lanes",
                                              items: [{
                                                lane: laneName,
                                                laneId: task.laneId,
                                                origin: task.origin,
                                                originState: task.originState,
                                                destination: task.destination,
                                                destinationState: task.destinationState,
                                                volume: task.volume,
                                                rate: task.rate,
                                                equipment: task.equipment,
                                                rfpTitle: task.rfpTitle,
                                              }],
                                            }],
                                          });
                                          setEditingTaskItem(undefined);
                                          setTaskDialogOpen(true);
                                        }}
                                        data-testid={`button-force-task-lane-${i}`}
                                      >
                                        <Zap className="h-4 w-4 mr-1" />Force Task
                                      </Button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {hiddenCount > 0 && (
                      <a href="/tasks" className="text-xs text-primary underline underline-offset-2 hover:opacity-80 block">
                        See all {sorted.length} lanes in Research Tasks →
                      </a>
                    )}
                  </div>
                );
              })()}
            </CardContent>
          </Card>
        );
      })()}

      {/* Contact Details */}
      {contacts && contacts.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <List className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-lg font-medium">Contact Details</h2>
            </div>
            {touchpointsThisMonth > 0 && (
              <span className="inline-flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-full px-2.5 py-1 font-medium" data-testid="badge-touchpoints-month">
                <PhoneCall className="h-3 w-3" />
                {touchpointsThisMonth} touch{touchpointsThisMonth === 1 ? "" : "points"} this month
              </span>
            )}
          </div>
          <ContactList
            contacts={contacts}
            companyId={companyId}
            touchpoints={companyTouchpoints}
            onEditContact={handleEditContact}
            onViewContact={setViewContact}
          />
        </div>
      )}

      {/* ── RFP tab dialogs ─────────────────────────────────────────────────── */}
      <RfpDialog
        open={cdRfpDialogOpen}
        onOpenChange={(open) => {
          setCdRfpDialogOpen(open);
          if (!open) setCdEditingRfp(undefined);
        }}
        rfp={cdEditingRfp}
        defaultCompanyId={companyId}
      />
      <AwardDialog
        open={cdAwardDialogOpen}
        onOpenChange={(open) => {
          setCdAwardDialogOpen(open);
          if (!open) setCdEditingAward(undefined);
        }}
        award={cdEditingAward}
        defaultCompanyId={companyId}
      />
      <ConvertToAwardDialog
        rfp={cdConvertingRfp}
        company={company}
        onClose={() => setCdConvertingRfp(null)}
      />
      <AlertDialog open={!!cdDeleteRfpTarget} onOpenChange={(open) => !open && setCdDeleteRfpTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete RFP</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{cdDeleteRfpTarget?.title}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => cdDeleteRfpTarget && cdDeleteRfpMutation.mutate(cdDeleteRfpTarget.id)}
            >
              {cdDeleteRfpMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!cdDeleteAwardTarget} onOpenChange={(open) => !open && setCdDeleteAwardTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Award</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{cdDeleteAwardTarget?.title}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => cdDeleteAwardTarget && cdDeleteAwardMutation.mutate(cdDeleteAwardTarget.id)}
            >
              {cdDeleteAwardMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Research Lane Dialog ─────────────────────────────────────────── */}
      {selectedTask && (
        <ResearchLaneDialog
          open={researchDialogOpen}
          onOpenChange={setResearchDialogOpen}
          lane={selectedTask}
          laneIndex={selectedTask.laneIndex}
          rfpId={selectedTask.rfpId}
          companyId={companyId}
        />
      )}

      {/* ── Find Planner / Assign Facility Dialog ────────────────────────── */}
      <Dialog
        open={!!findPlannerFacilityKey}
        onOpenChange={(open) => {
          if (!open) { setFindPlannerFacilityKey(null); setAssignExistingContactId(""); }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-red-500" />
              {findPlannerFacility?.fullName}
            </DialogTitle>
            <p className="text-sm text-muted-foreground pt-1">
              Manage contacts assigned to this facility.
            </p>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {findPlannerFacility && findPlannerFacility.coveredBy && findPlannerFacility.coveredBy.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Currently assigned</p>
                <div className="space-y-1.5">
                  {findPlannerFacility.coveredBy.map((c) => (
                    <div key={c.id} className="flex items-center justify-between px-3 py-2 rounded-md border bg-muted/40">
                      <span className="text-sm">{c.name}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        disabled={removeContactFromFacilityMutation.isPending}
                        onClick={() => {
                          removeContactFromFacilityMutation.mutate({
                            contactId: c.id,
                            laneToRemove: findPlannerFacility.fullName,
                          });
                        }}
                        data-testid={`button-remove-planner-${c.id}`}
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-2">
              <p className="text-sm font-medium">Add a contact</p>
              <Select value={assignExistingContactId} onValueChange={setAssignExistingContactId}>
                <SelectTrigger data-testid="select-existing-contact">
                  <SelectValue placeholder="Choose a contact…" />
                </SelectTrigger>
                <SelectContent>
                  {(contacts || [])
                    .filter((c) => !findPlannerFacility?.coveredBy?.some((cb) => cb.id === c.id))
                    .map(c => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}{c.title ? ` — ${c.title}` : ""}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Button
                className="w-full"
                disabled={!assignExistingContactId || assignContactToFacilityMutation.isPending}
                onClick={() => {
                  if (findPlannerFacility && assignExistingContactId) {
                    assignContactToFacilityMutation.mutate({
                      contactId: assignExistingContactId,
                      laneToAdd: findPlannerFacility.fullName,
                    });
                  }
                }}
                data-testid="button-assign-existing-contact"
              >
                {assignContactToFacilityMutation.isPending ? "Assigning…" : "Add to This Facility"}
              </Button>
            </div>
            <div className="relative">
              <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">or</span>
              </div>
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                const defaults = {
                  lane: findPlannerFacility?.fullName,
                  region: findPlannerFacility?.state || undefined,
                };
                setFindPlannerFacilityKey(null);
                setAssignExistingContactId("");
                onCreateContactForFacility(defaults);
              }}
              data-testid="button-create-new-contact-for-facility"
            >
              <UserPlus className="h-4 w-4 mr-2" />
              Create New Contact
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
