import { useState, useCallback, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Trophy,
  Plus,
  Search,
  FileText,
  Calendar,
  DollarSign,
  Building2,
  Clock,
  Send,
  Pencil,
  Trash2,
  Upload,
  FileSpreadsheet,
  MapPin,
  TruckIcon,
  BarChart3,
  X,
  AlertTriangle,
  UserPlus,
  Loader2,
  Paperclip,
  ArrowUpDown,
  ChevronsUpDown,
  ShieldAlert,
  ShieldCheck,
  CheckCircle,
  Route,
  ArrowRightLeft,
  Warehouse,
  ArrowDownToLine,
  ArrowUpFromLine,
  Repeat2,
  Users,
  ChevronDown,
  Sparkles,
  XCircle,
  Truck,
  ClipboardList,
  FolderOpen,
  CheckCircle2,
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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RfpDialog } from "@/components/rfp-dialog";
import { AwardDialog } from "@/components/award-dialog";
import { ConvertToAwardDialog } from "@/components/convert-to-award-dialog";
import { ResearchLaneDialog } from "@/components/research-lane-dialog";
import { DataAnalystPortlet } from "@/components/data-analyst-portlet";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Rfp, Award, Company, Contact, LaneCarrier } from "@shared/schema";
import { ProcurementTaskLauncherDialog, type ProcurementLaneInfo } from "@/components/carrier-procurement-workspace";

const rfpStatusConfig = {
  pending:           { label: "Pending",            icon: Clock,      color: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400" },
  submitted:         { label: "Submitted",          icon: Send,       color: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  awarded:           { label: "Awarded",            icon: Trophy,     color: "bg-green-500/10 text-green-600 dark:text-green-400" },
  partially_awarded: { label: "Partially Awarded",  icon: Trophy,     color: "bg-teal-500/10 text-teal-600 dark:text-teal-400" },
  lost:              { label: "Lost",               icon: XCircle,    color: "bg-red-500/10 text-red-600 dark:text-red-400" },
  declined:          { label: "Declined / No Bid",  icon: XCircle,    color: "bg-gray-500/10 text-gray-600 dark:text-gray-400" },
};

interface RfpCardProps {
  rfp: Rfp;
  company?: Company;
  onEdit: (rfp: Rfp) => void;
  onDelete: (rfp: Rfp) => void;
  onViewData: (rfp: Rfp) => void;
  onConvert: (rfp: Rfp) => void;
}

function RfpCard({ rfp, company, onEdit, onDelete, onViewData, onConvert }: RfpCardProps) {
  const status = rfpStatusConfig[rfp.status as keyof typeof rfpStatusConfig] || rfpStatusConfig.pending;
  const StatusIcon = status.icon;

  return (
    <Card className="hover-elevate" data-testid={`card-rfp-${rfp.id}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="min-w-0 flex-1">
            <h3 className="font-medium truncate">{rfp.title}</h3>
            {company && (
              <div className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
                <Building2 className="h-3 w-3" />
                <span className="truncate">{company.name}</span>
              </div>
            )}
          </div>
          <div className="flex flex-col items-end gap-1">
            <Badge className={status.color}>
              <StatusIcon className="h-3 w-3 mr-1" />
              {status.label}
            </Badge>
            {rfp.rfpType && (
              <Badge variant="outline" className={rfp.rfpType === "mini_bid" ? "text-blue-700 dark:text-blue-400 border-blue-300 dark:border-blue-700 text-xs" : "text-purple-700 dark:text-purple-400 border-purple-300 dark:border-purple-700 text-xs"} data-testid={`badge-rfp-type-${rfp.id}`}>
                {rfp.rfpType === "mini_bid" ? "Mini Bid" : "Full RFP"}
              </Badge>
            )}
          </div>
        </div>

        <div className="space-y-2 text-sm">
          {rfp.value && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <DollarSign className="h-3.5 w-3.5" />
              <span>${Number(rfp.value).toLocaleString()}</span>
            </div>
          )}
          {rfp.dueDate && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Calendar className="h-3.5 w-3.5" />
              <span>Due: {new Date(rfp.dueDate).toLocaleDateString()}</span>
            </div>
          )}
          {rfp.laneCount && rfp.laneCount > 0 && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <TruckIcon className="h-3.5 w-3.5" />
              <span>{rfp.laneCount} lanes</span>
            </div>
          )}
          {(() => {
            const fd = rfp.fileData as { highVolumeLanes?: any[] } | null;
            const hvCount = fd && !Array.isArray(fd) ? (fd.highVolumeLanes?.length || 0) : 0;
            return hvCount > 0 ? (
              <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span className="font-medium">{hvCount} lanes need contacts</span>
              </div>
            ) : null;
          })()}
          {rfp.fileName && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <FileSpreadsheet className="h-3.5 w-3.5" />
              <span className="truncate">{rfp.fileName}</span>
            </div>
          )}
          {rfp.originStates && rfp.originStates.length > 0 && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <MapPin className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">Origins: {rfp.originStates.join(", ")}</span>
            </div>
          )}
          {rfp.notes && (
            <p className="text-muted-foreground line-clamp-2">{rfp.notes}</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-1 mt-3 pt-3 border-t">
          <div className="flex items-center gap-1">
            {rfp.status !== "awarded" && rfp.status !== "partially_awarded" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onConvert(rfp)}
                className="text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                data-testid={`button-convert-award-${rfp.id}`}
              >
                <Trophy className="h-4 w-4 mr-1" />
                Mark as Won
              </Button>
            )}
          </div>
          <div className="flex items-center gap-1">
            {!!rfp.fileData && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onViewData(rfp)}
                data-testid={`button-view-data-${rfp.id}`}
              >
                <BarChart3 className="h-4 w-4 mr-1" />
                View Data
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onEdit(rfp)}
              data-testid={`button-edit-rfp-${rfp.id}`}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onDelete(rfp)}
              data-testid={`button-delete-rfp-${rfp.id}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function parseLaneString(laneStr: string, awardId: string): ProcurementLaneInfo | null {
  // Handles: "→", "->", " to " separators; volume formats "(N loads)", "(N shipments)", "(N shpts/yr)", etc.
  const match = laneStr.match(/^(.+?)\s*(?:→|->|\bto\b)\s*(.+?)(?:\s*\((\d[\d,]*)\s*(?:loads?|shipments?|shpts?)[^)]*\))?$/i);
  if (!match) return null;
  const origin = match[1].trim();
  const destination = match[2].trim();
  const volume = match[3] ? parseInt(match[3].replace(/,/g, "")) : 0;
  return {
    type: "carrier_procurement",
    lane: laneStr,
    origin,
    destination,
    volume,
    awardId,
  };
}

function getHighVolumeLanes(award: Award, customerName?: string): ProcurementLaneInfo[] {
  if (!award.lanes || award.lanes.length === 0) return [];
  return award.lanes
    .map(l => {
      const parsed = parseLaneString(l, award.id);
      if (!parsed) return null;
      return { ...parsed, awardTitle: award.title, customerName };
    })
    .filter((l): l is ProcurementLaneInfo => l !== null);
}

interface AwardCardProps {
  award: Award;
  company?: Company;
  onEdit: (award: Award) => void;
  onDelete: (award: Award) => void;
}

function AwardCard({ award, company, onEdit, onDelete }: AwardCardProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [procurementDialogOpen, setProcurementDialogOpen] = useState(false);
  const [activeProcLanes, setActiveProcLanes] = useState<ProcurementLaneInfo[]>([]);
  const [generatingTasks, setGeneratingTasks] = useState(false);
  const highVolumeLanes = getHighVolumeLanes(award, company?.name);

  const { data: awardCarriers = [] } = useQuery<LaneCarrier[]>({
    queryKey: ["/api/awards", award.id, "lane-carriers"],
  });

  const { data: procTaskStatus } = useQuery<{ taskCount: number }>({
    queryKey: ["/api/awards", award.id, "procurement-tasks"],
  });
  const hasExistingTasks = (procTaskStatus?.taskCount ?? 0) > 0;

  const coveredLanes = highVolumeLanes.filter(
    l => awardCarriers.filter(c => c.lane === l.lane && c.status !== "declined").length >= 5
  ).length;
  const totalLanes = highVolumeLanes.length;

  const getCoverageBadgeStyle = () => {
    if (totalLanes === 0) return null;
    if (coveredLanes === 0) return "bg-red-500/10 text-red-700 dark:text-red-400";
    if (coveredLanes < totalLanes) return "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400";
    return "bg-green-500/10 text-green-700 dark:text-green-400";
  };

  async function handleGenerateProcurementTasks() {
    if (!user) return;
    setGeneratingTasks(true);
    try {
      const res = await apiRequest("POST", `/api/awards/${award.id}/procurement-tasks`, {});
      const { results } = await res.json() as { results: Array<{ lane: string; taskId: string; created: boolean; failed?: boolean }> };
      const successResults = results.filter(r => !r.failed);
      const failedCount = results.filter(r => r.failed).length;
      const taskByLane = Object.fromEntries(successResults.map(r => [r.lane, r.taskId]));
      const createdLanes: ProcurementLaneInfo[] = highVolumeLanes
        .map(lane => {
          const normalizedLane = lane.lane.trim().replace(/\s+/g, " ").toLowerCase();
          const taskId = taskByLane[normalizedLane] ?? taskByLane[lane.lane];
          return taskId ? { ...lane, taskId } : null;
        })
        .filter((l): l is ProcurementLaneInfo => l !== null);
      const createdCount = successResults.filter(r => r.created).length;
      const reusedCount = successResults.filter(r => !r.created).length;
      if (createdCount > 0) {
        queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      }
      if (successResults.length > 0) {
        queryClient.invalidateQueries({ queryKey: ["/api/awards", award.id, "procurement-tasks"] });
      }
      setActiveProcLanes(createdLanes);
      setProcurementDialogOpen(true);
      if (failedCount > 0 && successResults.length > 0) {
        toast({
          title: `${successResults.length} task${successResults.length !== 1 ? "s" : ""} ready, ${failedCount} lane${failedCount !== 1 ? "s" : ""} failed`,
          description: "Workspace opened for successful lanes. Some lanes could not be set up — try again.",
        });
      } else {
        toast({
          title: createdCount > 0
            ? `${createdCount} procurement task${createdCount !== 1 ? "s" : ""} created`
            : "Opening existing procurement workspace",
          description: reusedCount > 0 && createdCount > 0
            ? `${reusedCount} existing task${reusedCount !== 1 ? "s" : ""} reused, ${createdCount} new.`
            : reusedCount > 0
            ? `Using ${reusedCount} existing task${reusedCount !== 1 ? "s" : ""} for this award.`
            : `One task per qualifying lane. Target 5–10 carrier contacts each.`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      let detail: string | undefined;
      try {
        const jsonPart = msg.replace(/^\d+:\s*/, "");
        detail = JSON.parse(jsonPart).error;
      } catch { /* ignore */ }
      toast({
        title: "Failed to generate procurement tasks",
        description: detail ?? "Please check the award has lanes in Origin → Destination format.",
        variant: "destructive",
      });
    } finally {
      setGeneratingTasks(false);
    }
  }

  const coverageStyle = getCoverageBadgeStyle();

  return (
    <>
      <Card className="hover-elevate" data-testid={`card-award-${award.id}`}>
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-2 mb-3">
            <div className="min-w-0 flex-1">
              <h3 className="font-medium truncate">{award.title}</h3>
              {company && (
                <div className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
                  <Building2 className="h-3 w-3" />
                  <span className="truncate">{company.name}</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {coverageStyle && (
                <Badge className={`text-xs ${coverageStyle}`} data-testid={`badge-procurement-coverage-${award.id}`}>
                  <Truck className="h-3 w-3 mr-1" />
                  {coveredLanes}/{totalLanes} covered
                </Badge>
              )}
              <Badge className="bg-green-500/10 text-green-600 dark:text-green-400">
                <Trophy className="h-3 w-3 mr-1" />
                Won
              </Badge>
            </div>
          </div>

          <div className="space-y-2 text-sm">
            {award.value && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <DollarSign className="h-3.5 w-3.5" />
                <span>${Number(award.value).toLocaleString()}</span>
              </div>
            )}
            {award.awardDate && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Calendar className="h-3.5 w-3.5" />
                <span>Awarded: {new Date(award.awardDate).toLocaleDateString()}</span>
              </div>
            )}
            {award.lanes && award.lanes.length > 0 && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <TruckIcon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">{award.lanes.join(", ")}</span>
              </div>
            )}
            {award.notes && (
              <p className="text-muted-foreground line-clamp-2">{award.notes}</p>
            )}
            {award.fileName && award.fileData && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Paperclip className="h-3.5 w-3.5 shrink-0" />
                <a
                  href={award.fileData}
                  download={award.fileName}
                  className="text-blue-600 dark:text-blue-400 hover:underline truncate text-sm"
                  onClick={(e) => e.stopPropagation()}
                  data-testid={`link-award-file-${award.id}`}
                >
                  {award.fileName}
                </a>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between mt-3 pt-3 border-t gap-2">
            <div className="flex items-center gap-1.5">
              <span
                className={highVolumeLanes.length === 0 ? "cursor-not-allowed" : undefined}
                title={highVolumeLanes.length === 0 ? "No lanes in recognized format — use Origin → Destination" : undefined}
              >
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleGenerateProcurementTasks}
                  disabled={generatingTasks || highVolumeLanes.length === 0}
                  className="text-xs h-8"
                  data-testid={`button-generate-procurement-${award.id}`}
                >
                  {generatingTasks ? (
                    <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                  ) : hasExistingTasks ? (
                    <FolderOpen className="h-3 w-3 mr-1.5" />
                  ) : (
                    <ClipboardList className="h-3 w-3 mr-1.5" />
                  )}
                  {hasExistingTasks ? "Open Procurement Workspace" : "Generate Procurement Tasks"}
                </Button>
              </span>
              {hasExistingTasks && (
                <Badge className="bg-green-500/10 text-green-700 dark:text-green-400 text-xs gap-1" data-testid={`badge-tasks-setup-${award.id}`}>
                  <CheckCircle2 className="h-3 w-3" />
                  Tasks set up
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onEdit(award)}
                data-testid={`button-edit-award-${award.id}`}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onDelete(award)}
                data-testid={`button-delete-award-${award.id}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {activeProcLanes.length > 0 && (
        <ProcurementTaskLauncherDialog
          open={procurementDialogOpen}
          onOpenChange={setProcurementDialogOpen}
          title={`Carrier Procurement — ${award.title}`}
          lanes={activeProcLanes}
        />
      )}
    </>
  );
}

interface HighVolumeLane {
  lane: string;
  origin: string;
  destination: string;
  originState: string;
  destinationState: string;
  volume: number;
  rate: string;
  equipment?: string;
  status?: string;
  contactId?: string;
}

interface Facility {
  facility: string;
  state: string;
  type: "origin" | "destination";
  totalVolume: number;
  laneCount: number;
  lanes: string[];
  rfpTitles: string[];
  fullName: string;
  covered: boolean;
  coveredBy: { id: string; name: string }[];
}

interface FacilityCoverage {
  facilities: Facility[];
  summary: { total: number; gaps: number; covered: number };
}

interface Corridor {
  origin: string;
  originState: string;
  destination: string;
  destinationState: string;
  totalVolume: number;
  count: number;
  rfpTitles: string[];
  lane: string;
  appearsInMultipleRfps: boolean;
}

interface Hub {
  facility: string;
  state: string;
  inboundVolume: number;
  outboundVolume: number;
  inboundCount: number;
  outboundCount: number;
  fullName: string;
  totalVolume: number;
}

interface StateCorridor {
  originState: string;
  destinationState: string;
  totalVolume: number;
  laneCount: number;
  corridor: string;
}

interface LanePatterns {
  topCorridors: Corridor[];
  hubs: Hub[];
  stateCorridors: StateCorridor[];
}

interface RfpDataViewerProps {
  rfp: Rfp;
  companyId: string;
  onClose: () => void;
  onRfpUpdated?: () => void;
}

function RfpDataViewer({ rfp, companyId, onClose, onRfpUpdated }: RfpDataViewerProps) {
  const { toast } = useToast();
  const [researchDialogOpen, setResearchDialogOpen] = useState(false);
  const [selectedLane, setSelectedLane] = useState<HighVolumeLane | null>(null);
  const [selectedLaneIndex, setSelectedLaneIndex] = useState(0);
  const [laneSort, setLaneSort] = useState<{ col: string; dir: "asc" | "desc" }>({ col: "origin", dir: "asc" });
  const [hvLanesCollapsed, setHvLanesCollapsed] = useState(false);
  const [laneSearch, setLaneSearch] = useState("");
  const [dataViewerCollapsed, setDataViewerCollapsed] = useState(false);
  const [rfpFacilityCoverageCollapsed, setRfpFacilityCoverageCollapsed] = useState(false);
  const [rfpLanePatternsCollapsed, setRfpLanePatternsCollapsed] = useState(false);
  const [assignExistingContactId, setAssignExistingContactId] = useState("");

  const { data: facilityCoverage } = useQuery<FacilityCoverage>({
    queryKey: ["/api/companies", companyId, "facility-coverage"],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/facility-coverage`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch facility coverage");
      return res.json();
    },
    enabled: !!companyId,
  });

  const [findPlannerFacilityKey, setFindPlannerFacilityKey] = useState<string | null>(null);
  const findPlannerFacility = findPlannerFacilityKey
    ? (facilityCoverage?.facilities.find(
        (f) => `${f.fullName}|${f.type}` === findPlannerFacilityKey
      ) ?? null)
    : null;
  const setFindPlannerFacility = (f: Facility | null) =>
    setFindPlannerFacilityKey(f ? `${f.fullName}|${f.type}` : null);

  const { data: lanePatterns } = useQuery<LanePatterns>({
    queryKey: ["/api/companies", companyId, "lane-patterns"],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/lane-patterns`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch lane patterns");
      return res.json();
    },
    enabled: !!companyId,
  });

  const { data: contacts } = useQuery<Contact[]>({
    queryKey: ["/api/companies", companyId, "contacts"],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/contacts`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch contacts");
      return res.json();
    },
    enabled: !!companyId,
  });

  const assignContactToFacilityMutation = useMutation({
    mutationFn: async ({ contactId, laneToAdd }: { contactId: string; laneToAdd: string }) => {
      const contact = contacts?.find((c) => c.id === contactId);
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
      toast({
        title: "Contact assigned to facility",
        className: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Error assigning contact", description: error.message, variant: "destructive" });
    },
  });

  const removeContactFromFacilityMutation = useMutation({
    mutationFn: async ({ contactId, laneToRemove }: { contactId: string; laneToRemove: string }) => {
      const contact = contacts?.find((c) => c.id === contactId);
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
      toast({
        title: "Contact removed from facility",
        className: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Error removing contact", description: error.message, variant: "destructive" });
    },
  });

  const markResearchedMutation = useMutation({
    mutationFn: async ({ laneIdx }: { laneIdx: number }) => {
      await apiRequest("PATCH", `/api/rfps/${rfp.id}/lanes/${laneIdx}/status`, {
        status: "researched",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rfps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/research-tasks"] });
      onRfpUpdated?.();
      toast({
        title: "Lane marked as researched",
        className: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800",
      });
    },
  });

  const fileDataObj = rfp.fileData as { rows?: Record<string, any>[]; highVolumeLanes?: HighVolumeLane[]; sheetName?: string } | Record<string, any>[] | null;

  let rows: Record<string, any>[] = [];
  let highVolumeLanes: HighVolumeLane[] = [];
  let detectedSheetName: string | null = null;

  if (Array.isArray(fileDataObj)) {
    rows = fileDataObj;
  } else if (fileDataObj && typeof fileDataObj === "object") {
    rows = fileDataObj.rows || [];
    highVolumeLanes = fileDataObj.highVolumeLanes || [];
    detectedSheetName = fileDataObj.sheetName || null;
  }

  if (rows.length === 0 && highVolumeLanes.length === 0) return null;
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];

  const rfpContextData = useMemo(() => {
    const lines: string[] = [
      `RFP: ${rfp.title}`,
      rfp.fileName ? `File: ${rfp.fileName}` : "",
      detectedSheetName ? `Source Tab: "${detectedSheetName}"` : "",
      `Status: ${rfp.status}`,
      rfp.value ? `Estimated Value: $${Number(rfp.value).toLocaleString()}` : "",
      rfp.dueDate ? `Due Date: ${rfp.dueDate}` : "",
      rfp.laneCount ? `Total Lanes: ${rfp.laneCount}` : "",
      rfp.totalVolume ? `Total Annual Volume: ${Number(rfp.totalVolume).toLocaleString()} loads` : "",
      rfp.originStates?.length ? `Origin States: ${rfp.originStates.join(", ")}` : "",
      rfp.notes ? `Notes: ${rfp.notes}` : "",
    ].filter(Boolean);

    if (highVolumeLanes.length > 0) {
      lines.push("", "HIGH VOLUME LANES (50+ loads/yr, need planner/contact):");
      highVolumeLanes.slice(0, 40).forEach(l => {
        lines.push(`  • ${l.origin || ""} → ${l.destination || ""} | ${l.volume?.toLocaleString() ?? "?"} loads/yr | ${l.equipment || ""} | Status: ${l.status || "open"}`);
      });
    }

    if (rows.length > 0) {
      const allColumns = Object.keys(rows[0]);
      lines.push("", `RFP SPREADSHEET COLUMNS (${allColumns.length}): ${allColumns.join(" | ")}`);

      const laneCol = ["Lane", "lane", "LANE REF ID", "Origin City", "origin_city"].find(k => k in rows[0]);
      const volCol = ["Annual Volume", "annual_volume", "Volume", "volume"].find(k => k in rows[0]);
      const origCol = ["Origin City", "Origin city", "origin_city"].find(k => k in rows[0]);
      const destCol = ["Destination City", "Destination city", "destination_city"].find(k => k in rows[0]);
      const eqCol = ["Equipment Type", "Equipment", "equipment"].find(k => k in rows[0]);
      const stateOrigCol = ["Origin State", "origin_state"].find(k => k in rows[0]);
      const stateDestCol = ["Destination State", "destination_state"].find(k => k in rows[0]);

      const laneRows = rows
        .map(r => ({
          lane: origCol && destCol ? `${r[origCol]}, ${stateOrigCol ? r[stateOrigCol] || "" : ""} → ${r[destCol]}, ${stateDestCol ? r[stateDestCol] || "" : ""}` : (laneCol ? r[laneCol] : ""),
          volume: volCol ? Number(String(r[volCol]).replace(/[^0-9.]/g, "")) || 0 : 0,
          equipment: eqCol ? r[eqCol] : "",
        }))
        .filter(r => r.lane)
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 50);

      if (laneRows.length > 0) {
        lines.push("", "TOP LANES BY ANNUAL VOLUME:");
        laneRows.forEach(l => {
          lines.push(`  • ${l.lane} | ${l.volume.toLocaleString()} loads/yr${l.equipment ? ` | ${l.equipment}` : ""}`);
        });
      }

      // Full raw rows — send all of them so the AI can analyze every lane
      lines.push("", `FULL RFP RAW DATA (${rows.length} rows, all columns):`);
      lines.push(allColumns.join(" | "));
      rows.forEach(r => {
        lines.push(allColumns.map(col => String(r[col] ?? "")).join(" | "));
      });
    }

    return lines.join("\n");
  }, [rfp, highVolumeLanes, rows]);

  const openLanes = highVolumeLanes.filter(l => !l.status || l.status === "open");
  const completedLanes = highVolumeLanes.filter(l => l.status && l.status !== "open");

  const handleAssign = (lane: HighVolumeLane, index: number) => {
    setSelectedLane(lane);
    setSelectedLaneIndex(index);
    setResearchDialogOpen(true);
  };

  const getLaneStatusBadge = (lane: HighVolumeLane) => {
    if (!lane.status || lane.status === "open") {
      return <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">Open</Badge>;
    }
    if (lane.status === "contact_added") {
      return <Badge className="bg-blue-500/10 text-blue-600 dark:text-blue-400">Contact Added</Badge>;
    }
    if (lane.status === "researched") {
      return <Badge className="bg-green-500/10 text-green-600 dark:text-green-400">Researched</Badge>;
    }
    return <Badge variant="secondary">{lane.status}</Badge>;
  };

  return (
    <div className="space-y-4">
      {detectedSheetName && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
          <FileSpreadsheet className="h-3.5 w-3.5 shrink-0" />
          <span>Analyzing data from tab <span className="font-semibold text-foreground">"{detectedSheetName}"</span> — the tab with the most lane data</span>
        </div>
      )}
      {highVolumeLanes.length > 0 && (
        <Card className="border-2 border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20">
          <CardHeader className="pb-3">
            <button
              onClick={() => setHvLanesCollapsed(c => !c)}
              className="w-full flex items-center justify-between group"
              data-testid="btn-toggle-hv-lanes"
            >
              <CardTitle className="text-base flex items-center gap-2 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" />
                High-Volume Lanes — Action Required
              </CardTitle>
              <div className="flex items-center gap-2">
                {completedLanes.length > 0 && (
                  <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400">
                    {completedLanes.length} completed
                  </Badge>
                )}
                <Badge variant="secondary" className="bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400">
                  {openLanes.length} open
                </Badge>
                <ChevronDown className={`h-4 w-4 text-amber-600 dark:text-amber-400 transition-transform duration-200 ${hvLanesCollapsed ? "-rotate-90" : ""}`} />
              </div>
            </button>
            {!hvLanesCollapsed && (
              <p className="text-sm text-muted-foreground mt-1">
                These lanes have more than 50 annual loads. Assign a planner to research who owns each lane.
              </p>
            )}
          </CardHeader>
          {!hvLanesCollapsed && (
            <CardContent className="pt-0">
            {(() => {
              const fmtLoc = (city: string, state: string) => {
                if (!city && !state) return "—";
                if (!city) return state;
                if (!state) return city;
                if (city.toUpperCase().includes(state.toUpperCase())) return city;
                return `${city}, ${state}`;
              };

              const handleLaneSort = (col: string) => {
                setLaneSort((prev) =>
                  prev.col === col
                    ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
                    : { col, dir: col === "volume" ? "desc" : "asc" }
                );
              };

              const SortIcon = ({ col }: { col: string }) => (
                laneSort.col === col
                  ? <ArrowUpDown className={`h-3 w-3 ml-1 inline ${laneSort.dir === "asc" ? "rotate-180" : ""}`} />
                  : <ChevronsUpDown className="h-3 w-3 ml-1 inline opacity-40" />
              );

              const sortedLanes = [...highVolumeLanes].map((lane, origIdx) => ({ lane, origIdx })).sort((a, b) => {
                const dir = laneSort.dir === "asc" ? 1 : -1;
                switch (laneSort.col) {
                  case "origin": return dir * fmtLoc(a.lane.origin, a.lane.originState).localeCompare(fmtLoc(b.lane.origin, b.lane.originState));
                  case "destination": return dir * fmtLoc(a.lane.destination, a.lane.destinationState).localeCompare(fmtLoc(b.lane.destination, b.lane.destinationState));
                  case "volume": return dir * (a.lane.volume - b.lane.volume);
                  case "equipment": return dir * (a.lane.equipment || "").localeCompare(b.lane.equipment || "");
                  case "miles": return dir * ((a.lane.miles ?? 0) - (b.lane.miles ?? 0));
                  case "status": return dir * (a.lane.status || "open").localeCompare(b.lane.status || "open");
                  default: return 0;
                }
              });

              const thClass = "px-3 py-2 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide cursor-pointer select-none hover:text-foreground transition-colors whitespace-nowrap";

              const hasMiles = sortedLanes.some(({ lane }) => lane.miles != null);

              const displayedLanes = laneSearch.trim()
                ? sortedLanes.filter(({ lane }) => {
                    const q = laneSearch.toLowerCase();
                    const orig = fmtLoc(lane.origin, lane.originState).toLowerCase();
                    const dest = fmtLoc(lane.destination, lane.destinationState).toLowerCase();
                    return orig.includes(q) || dest.includes(q);
                  })
                : sortedLanes;

              return (
                <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Filter by origin or destination…"
                    value={laneSearch}
                    onChange={e => setLaneSearch(e.target.value)}
                    className="h-8 w-full max-w-xs rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    data-testid="input-lane-search"
                  />
                  {laneSearch && (
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {displayedLanes.length} of {sortedLanes.length} lanes
                    </span>
                  )}
                </div>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm" data-testid="table-high-volume-lanes">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className={thClass} onClick={() => handleLaneSort("origin")}>
                          Origin <SortIcon col="origin" />
                        </th>
                        <th className={thClass} onClick={() => handleLaneSort("destination")}>
                          Destination <SortIcon col="destination" />
                        </th>
                        <th className={thClass} onClick={() => handleLaneSort("volume")}>
                          Volume <SortIcon col="volume" />
                        </th>
                        {hasMiles && (
                          <th className={thClass} onClick={() => handleLaneSort("miles")}>
                            Miles <SortIcon col="miles" />
                          </th>
                        )}
                        <th className={thClass} onClick={() => handleLaneSort("equipment")}>
                          Equipment <SortIcon col="equipment" />
                        </th>
                        <th className={thClass} onClick={() => handleLaneSort("status")}>
                          Status <SortIcon col="status" />
                        </th>
                        <th className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                          Action
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayedLanes.map(({ lane, origIdx }) => (
                        <tr
                          key={origIdx}
                          className={`border-b last:border-0 transition-colors ${
                            lane.status && lane.status !== "open"
                              ? "bg-green-50/50 dark:bg-green-950/10"
                              : "hover:bg-muted/30"
                          }`}
                          data-testid={`high-volume-lane-${origIdx}`}
                        >
                          <td className="px-3 py-2 font-medium">
                            {fmtLoc(lane.origin, lane.originState)}
                          </td>
                          <td className="px-3 py-2 font-medium">
                            {fmtLoc(lane.destination, lane.destinationState)}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                            {Math.round(lane.volume).toLocaleString()} / yr
                          </td>
                          {hasMiles && (
                            <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                              {lane.miles != null ? `${Math.round(lane.miles).toLocaleString()} mi` : "—"}
                            </td>
                          )}
                          <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                            {lane.equipment || "—"}
                          </td>
                          <td className="px-3 py-2">
                            {getLaneStatusBadge(lane)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {(!lane.status || lane.status === "open") ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-900/30"
                                onClick={() => handleAssign(lane, origIdx)}
                                data-testid={`button-assign-lane-${origIdx}`}
                              >
                                <UserPlus className="h-4 w-4 mr-1" />
                                Assign Lane to Planner
                              </Button>
                            ) : lane.status === "contact_added" ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-green-300 text-green-700 hover:bg-green-100 dark:border-green-700 dark:text-green-400 dark:hover:bg-green-900/30"
                                onClick={() => markResearchedMutation.mutate({ laneIdx: origIdx })}
                                disabled={markResearchedMutation.isPending}
                                data-testid={`button-mark-researched-${origIdx}`}
                              >
                                Mark Complete
                              </Button>
                            ) : (
                              <span className="text-xs text-green-600 dark:text-green-400">Done</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                </div>
              );
            })()}
          </CardContent>
          )}
        </Card>
      )}

      <Card className="border-2 border-primary/20">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setDataViewerCollapsed(c => !c)}
              className="flex-1 flex items-start justify-between text-left group"
              data-testid="btn-toggle-data-viewer"
            >
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3 className="h-4 w-4" />
                  {rfp.title} - Spreadsheet Data
                </CardTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  {rfp.fileName} - {rows.length} rows
                </p>
              </div>
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200 mt-1 ${dataViewerCollapsed ? "-rotate-90" : ""}`} />
            </button>
            <Button size="icon" variant="ghost" onClick={onClose} data-testid="button-close-data-viewer" className="ml-1">
              <X className="h-4 w-4" />
            </Button>
          </div>

          {!dataViewerCollapsed && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
            {rfp.laneCount && rfp.laneCount > 0 && (
              <div className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
                <TruckIcon className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">Total Lanes</p>
                  <p className="font-medium text-sm">{rfp.laneCount}</p>
                </div>
              </div>
            )}
            {highVolumeLanes.length > 0 && (
              <div className="flex items-center gap-2 p-2 rounded-md bg-amber-50 dark:bg-amber-950/30">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <div>
                  <p className="text-xs text-muted-foreground">50+ Volume</p>
                  <p className="font-medium text-sm text-amber-700 dark:text-amber-400">{highVolumeLanes.length}</p>
                </div>
              </div>
            )}
            {rfp.totalVolume && rfp.totalVolume !== "0" && (
              <div className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">Total Volume</p>
                  <p className="font-medium text-sm">{Number(rfp.totalVolume).toLocaleString()}</p>
                </div>
              </div>
            )}
            {rfp.originStates && rfp.originStates.length > 0 && (
              <div className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
                <MapPin className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">Origin States</p>
                  <p className="font-medium text-sm">{rfp.originStates.length}</p>
                </div>
              </div>
            )}
          </div>
          )}
        </CardHeader>
        {!dataViewerCollapsed && rows.length > 0 && (
          <CardContent className="pt-0">
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm" data-testid="table-rfp-data">
                <thead>
                  <tr className="border-b bg-muted/50">
                    {headers.map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 50).map((row, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                      {headers.map((h) => (
                        <td key={h} className="px-3 py-2 whitespace-nowrap">
                          {String(row[h] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 50 && (
                <p className="text-sm text-muted-foreground text-center py-2">
                  Showing 50 of {rows.length} rows
                </p>
              )}
            </div>
          </CardContent>
        )}
      </Card>

      {facilityCoverage && facilityCoverage.facilities.length > 0 && (
        <Card data-testid="card-facility-coverage-viewer">
          <CardHeader className="pb-3">
            <button
              onClick={() => setRfpFacilityCoverageCollapsed(c => !c)}
              className="w-full flex items-center justify-between group"
              data-testid="btn-toggle-rfp-facility-coverage"
            >
              <div className="flex items-center gap-2">
                <MapPin className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                <h2 className="text-base font-medium">Facility Coverage</h2>
              </div>
              <div className="flex items-center gap-2">
                {facilityCoverage.summary.gaps > 0 && (
                  <Badge className="bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400">
                    <ShieldAlert className="h-3 w-3 mr-1" />
                    {facilityCoverage.summary.gaps} gap{facilityCoverage.summary.gaps !== 1 ? "s" : ""}
                  </Badge>
                )}
                {facilityCoverage.summary.covered > 0 && (
                  <Badge className="bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400">
                    <ShieldCheck className="h-3 w-3 mr-1" />
                    {facilityCoverage.summary.covered} covered
                  </Badge>
                )}
                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${rfpFacilityCoverageCollapsed ? "-rotate-90" : ""}`} />
              </div>
            </button>
          </CardHeader>
          {!rfpFacilityCoverageCollapsed && (
          <CardContent className="pt-0">
            <div className="space-y-2">
              {facilityCoverage.facilities.map((f, i) => (
                <div
                  key={`${f.fullName}-${f.type}-${i}`}
                  className={`flex items-center justify-between p-3 rounded-md border transition-colors ${
                    f.covered
                      ? "bg-green-50/50 border-green-200/50 dark:bg-green-950/20 dark:border-green-800/30"
                      : "bg-red-50/50 border-red-200/50 dark:bg-red-950/20 dark:border-red-800/30"
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className={`flex h-8 w-8 items-center justify-center rounded-lg flex-shrink-0 ${
                      f.covered
                        ? "bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400"
                        : "bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400"
                    }`}>
                      <MapPin className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-sm">{f.fullName}</p>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          {f.type === "origin" ? "Origin" : "Destination"}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                        <span className="flex items-center gap-1">
                          <BarChart3 className="h-3 w-3" />
                          {f.totalVolume.toLocaleString()} loads/yr
                        </span>
                        <span>{f.laneCount} lane{f.laneCount !== 1 ? "s" : ""}</span>
                        {f.covered && f.coveredBy && f.coveredBy.length > 0 && (
                          <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
                            <Users className="h-3 w-3" />
                            {f.coveredBy.map(c => c.name).join(", ")}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex-shrink-0 flex items-center gap-1.5">
                    {f.covered ? (
                      <>
                        <Badge className="bg-green-500/10 text-green-600 dark:text-green-400">
                          <CheckCircle className="h-3 w-3 mr-1" />
                          Covered
                        </Badge>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          onClick={() => {
                            setAssignExistingContactId("");
                            setFindPlannerFacility(f);
                          }}
                          data-testid={`button-manage-planners-viewer-${i}`}
                        >
                          Manage
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-red-300 text-red-700 hover:bg-red-100 dark:border-red-700 dark:text-red-400"
                        onClick={() => {
                          setAssignExistingContactId("");
                          setFindPlannerFacility(f);
                        }}
                        data-testid={`button-find-planner-viewer-${i}`}
                      >
                        <UserPlus className="h-4 w-4 mr-1" />
                        Find Planner
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
          )}
        </Card>
      )}

      {lanePatterns && (lanePatterns.topCorridors.length > 0 || lanePatterns.hubs.length > 0 || lanePatterns.stateCorridors.length > 0) && (
        <Card data-testid="card-lane-patterns-viewer">
          <CardHeader className="pb-3">
            <button
              onClick={() => setRfpLanePatternsCollapsed(c => !c)}
              className="w-full flex items-center justify-between group"
              data-testid="btn-toggle-rfp-lane-patterns"
            >
              <div className="flex items-center gap-2">
                <Route className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                <h2 className="text-base font-medium">Lane Patterns</h2>
              </div>
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${rfpLanePatternsCollapsed ? "-rotate-90" : ""}`} />
            </button>
          </CardHeader>
          {!rfpLanePatternsCollapsed && (
          <CardContent className="pt-0">
            <Tabs defaultValue="corridors" className="w-full">
              <TabsList className="w-full grid grid-cols-3">
                <TabsTrigger value="corridors">
                  <ArrowRightLeft className="h-3.5 w-3.5 mr-1.5" />
                  Top Corridors
                </TabsTrigger>
                <TabsTrigger value="hubs">
                  <Warehouse className="h-3.5 w-3.5 mr-1.5" />
                  Shipping/Receiving Hubs
                </TabsTrigger>
                <TabsTrigger value="states">
                  <Repeat2 className="h-3.5 w-3.5 mr-1.5" />
                  State Corridors
                </TabsTrigger>
              </TabsList>

              <TabsContent value="corridors" className="mt-3">
                {lanePatterns.topCorridors.length > 0 ? (
                  <div className="space-y-2">
                    {lanePatterns.topCorridors.map((c, i) => (
                      <div
                        key={i}
                        className={`flex items-center justify-between p-3 rounded-md border bg-background hover:bg-muted/50 transition-colors ${
                          c.appearsInMultipleRfps ? "border-blue-200 dark:border-blue-800/50" : ""
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 flex-shrink-0">
                            <TruckIcon className="h-4 w-4" />
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium text-sm truncate">{c.lane}</p>
                            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                              <span className="flex items-center gap-1">
                                <BarChart3 className="h-3 w-3" />
                                {c.totalVolume.toLocaleString()} loads/yr
                              </span>
                              {c.count > 1 && (
                                <span className="text-blue-600 dark:text-blue-400 font-medium">
                                  appears {c.count}x
                                </span>
                              )}
                              {c.appearsInMultipleRfps && (
                                <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400 text-[10px] px-1.5 py-0">
                                  Multi-RFP
                                </Badge>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="text-right text-xs text-muted-foreground flex-shrink-0 ml-2">
                          <span className="font-mono">{c.rfpTitles.join(", ")}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-6">No corridor data available</p>
                )}
              </TabsContent>

              <TabsContent value="hubs" className="mt-3">
                {lanePatterns.hubs.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground mb-2">
                      Facilities that appear as both origins and destinations — likely managed by dedicated planners.
                    </p>
                    {lanePatterns.hubs.map((h, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between p-3 rounded-md border bg-background hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 flex-shrink-0">
                            <Warehouse className="h-4 w-4" />
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium text-sm">{h.fullName}</p>
                            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                              <span className="flex items-center gap-1">
                                <BarChart3 className="h-3 w-3" />
                                {h.totalVolume.toLocaleString()} total loads/yr
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <div className="text-center">
                            <div className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                              <ArrowUpFromLine className="h-3 w-3" />
                              <span className="font-medium">{h.outboundVolume.toLocaleString()}</span>
                            </div>
                            <span className="text-[10px] text-muted-foreground">{h.outboundCount} outbound</span>
                          </div>
                          <div className="text-center">
                            <div className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
                              <ArrowDownToLine className="h-3 w-3" />
                              <span className="font-medium">{h.inboundVolume.toLocaleString()}</span>
                            </div>
                            <span className="text-[10px] text-muted-foreground">{h.inboundCount} inbound</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-6">
                    No facilities appear as both origins and destinations
                  </p>
                )}
              </TabsContent>

              <TabsContent value="states" className="mt-3">
                {lanePatterns.stateCorridors.length > 0 ? (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-muted/50 border-b">
                          <th className="text-left font-medium px-3 py-2">Corridor</th>
                          <th className="text-right font-medium px-3 py-2">Lanes</th>
                          <th className="text-right font-medium px-3 py-2">Volume</th>
                          <th className="text-left px-3 py-2 w-1/3">Share</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          const maxVol = Math.max(...lanePatterns.stateCorridors.map(s => s.totalVolume));
                          return lanePatterns.stateCorridors.map((s, i) => (
                            <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                              <td className="px-3 py-2">
                                <span className="font-medium">{s.corridor}</span>
                              </td>
                              <td className="px-3 py-2 text-right text-muted-foreground">{s.laneCount}</td>
                              <td className="px-3 py-2 text-right font-medium">{s.totalVolume.toLocaleString()}</td>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                                    <div
                                      className="h-full bg-gradient-to-r from-blue-500 to-green-500 rounded-full transition-all"
                                      style={{ width: `${(s.totalVolume / maxVol) * 100}%` }}
                                    />
                                  </div>
                                </div>
                              </td>
                            </tr>
                          ));
                        })()}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-6">No state corridor data available</p>
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
          )}
        </Card>
      )}

      <Card data-testid="card-rfp-ai-analysis">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-500" />
            DNA Analysis
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">Ask Claude to analyze this RFP, surface trends, and help you turn insights into action</p>
        </CardHeader>
        <CardContent className="pt-0">
          <DataAnalystPortlet
            contextType="rfp"
            contextData={rfpContextData}
            companyId={companyId}
            presetQuestions={[
              "What are the top opportunities in this RFP?",
              "Which lanes should we prioritize and why?",
              "What equipment types dominate and what does that mean for our network?",
              "What are the risks or challenges in this bid?",
              "Give me a summary of this RFP I can share with my team",
            ]}
          />
        </CardContent>
      </Card>

      <ResearchLaneDialog
        open={researchDialogOpen}
        onOpenChange={setResearchDialogOpen}
        lane={selectedLane}
        laneIndex={selectedLaneIndex}
        rfpId={rfp.id}
        companyId={companyId}
      />

      <Dialog
        open={!!findPlannerFacility}
        onOpenChange={(open) => {
          if (!open) {
            setFindPlannerFacility(null);
            setAssignExistingContactId("");
          }
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
                <SelectTrigger data-testid="select-assign-contact">
                  <SelectValue placeholder="Choose a contact…" />
                </SelectTrigger>
                <SelectContent>
                  {(contacts || [])
                    .filter((c) => !findPlannerFacility?.coveredBy?.some((cb) => cb.id === c.id))
                    .map((c) => (
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
                data-testid="button-assign-contact"
              >
                {assignContactToFacilityMutation.isPending ? "Assigning…" : "Add to This Facility"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              To create a new contact, visit the account page from the Customers tab.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function RfpAwards() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [rfpDialogOpen, setRfpDialogOpen] = useState(false);
  const [awardDialogOpen, setAwardDialogOpen] = useState(false);
  const [editingRfp, setEditingRfp] = useState<Rfp | undefined>();
  const [editingAward, setEditingAward] = useState<Award | undefined>();
  const [procurementPromptAward, setProcurementPromptAward] = useState<Award | null>(null);
  const [procurementPromptLanes, setProcurementPromptLanes] = useState<ProcurementLaneInfo[]>([]);
  const [promptProcDialogOpen, setPromptProcDialogOpen] = useState(false);
  const [promptProcLanes, setPromptProcLanes] = useState<ProcurementLaneInfo[]>([]);
  const [promptProcTitle, setPromptProcTitle] = useState("");
  const [promptGeneratingTasks, setPromptGeneratingTasks] = useState(false);
  const [deleteRfpTarget, setDeleteRfpTarget] = useState<Rfp | null>(null);
  const [deleteAwardTarget, setDeleteAwardTarget] = useState<Award | null>(null);
  const [viewingRfp, setViewingRfp] = useState<Rfp | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploadCompanyId, setUploadCompanyId] = useState("");
  const [columnMappingOpen, setColumnMappingOpen] = useState(false);
  const [columnMappingData, setColumnMappingData] = useState<{
    headers: string[];
    suggestedMappings: Record<string, string>;
    confident: boolean;
    sheetName: string;
    columnSamples: Record<string, string[]>;
  } | null>(null);
  const [confirmedMapping, setConfirmedMapping] = useState<Record<string, string>>({});
  const [uploadRfpType, setUploadRfpType] = useState<"mini_bid" | "full_rfp" | "">("");
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false);
  const [pdfExtractedLanes, setPdfExtractedLanes] = useState<any[]>([]);
  const [pdfRfpType, setPdfRfpType] = useState<"mini_bid" | "full_rfp" | "">("");
  const [drilldownFilter, setDrilldownFilter] = useState<"rfps" | "awards" | "pipeline" | "awarded" | null>(null);
  const [convertingRfp, setConvertingRfp] = useState<Rfp | null>(null);

  const { data: rfps, isLoading: rfpsLoading } = useQuery<Rfp[]>({
    queryKey: ["/api/rfps"],
  });

  const { data: allAwards, isLoading: awardsLoading } = useQuery<Award[]>({
    queryKey: ["/api/awards"],
  });

  const { data: companies } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const deleteRfpMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/rfps/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rfps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/research-tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      toast({ title: "RFP deleted successfully" });
      setDeleteRfpTarget(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error deleting RFP", description: error.message, variant: "destructive" });
    },
  });

  const deleteAwardMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/awards/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/awards"] });
      toast({ title: "Award deleted successfully" });
      setDeleteAwardTarget(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error deleting award", description: error.message, variant: "destructive" });
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ file, companyId, mapping, rfpType }: { file: File; companyId: string; mapping?: Record<string, string>; rfpType?: string }) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("companyId", companyId);
      if (mapping) {
        formData.append("confirmedMapping", JSON.stringify(mapping));
      }
      if (rfpType) {
        formData.append("rfpType", rfpType);
      }
      const response = await fetch("/api/rfps/upload", { method: "POST", body: formData });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Upload failed");
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/rfps"] });
      setPendingFile(null);
      setColumnMappingOpen(false);
      setColumnMappingData(null);
      setConfirmedMapping({});
      setUploadRfpType("");
      const sheetInfo = data.sheetName ? ` (tab: "${data.sheetName}")` : "";
      const laneCount = data.analysis?.laneCount ?? 0;
      if (laneCount === 0) {
        toast({
          title: "RFP uploaded with warnings",
          description: `No lanes were detected in ${data.rfp.fileName}${sheetInfo}. Check that the column mapping is correct.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "RFP uploaded successfully",
          description: `Analyzed ${laneCount} lanes from ${data.rfp.fileName}${sheetInfo}`,
        });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    },
  });

  const previewHeadersMutation = useMutation({
    mutationFn: async ({ file }: { file: File }) => {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/rfps/preview-headers", { method: "POST", body: formData });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to analyze file");
      }
      return response.json();
    },
    onSuccess: (data) => {
      if (data.isPdf) {
        setPdfExtractedLanes(data.extractedLanes || []);
        setPdfRfpType("");
        setPdfPreviewOpen(true);
      } else {
        setColumnMappingData(data);
        setConfirmedMapping({ ...data.suggestedMappings });
        setColumnMappingOpen(true);
      }
    },
    onError: (error: Error) => {
      toast({ title: "Failed to analyze file", description: error.message, variant: "destructive" });
    },
  });

  const uploadPdfMutation = useMutation({
    mutationFn: async ({ companyId, rfpType, lanes, fileName }: { companyId: string; rfpType: string; lanes: any[]; fileName: string }) => {
      const response = await fetch("/api/rfps/upload-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, rfpType, lanes, fileName }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to save RFP");
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/rfps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/research-tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      setPdfPreviewOpen(false);
      setPdfExtractedLanes([]);
      setPdfRfpType("");
      setPendingFile(null);
      toast({
        title: "RFP created from PDF",
        description: `AI extracted ${data.laneCount} lane${data.laneCount !== 1 ? "s" : ""} from the document`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    },
  });

  const triggerUpload = useCallback((file: File) => {
    setPendingFile(file);
    if (!uploadCompanyId) {
      return;
    }
    previewHeadersMutation.mutate({ file });
  }, [uploadCompanyId, previewHeadersMutation]);

  const companiesMap = new Map(companies?.map((c) => [c.id, c]) || []);

  const filteredRfps = rfps?.filter((rfp) =>
    rfp.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    companiesMap.get(rfp.companyId)?.name.toLowerCase().includes(searchQuery.toLowerCase())
  ) || [];

  const filteredAwards = allAwards?.filter((award) =>
    award.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    companiesMap.get(award.companyId)?.name.toLowerCase().includes(searchQuery.toLowerCase())
  ) || [];

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const isValidRfpFile = (file: File) =>
    file.name.endsWith(".xlsx") || file.name.endsWith(".xls") || file.name.endsWith(".csv") || file.name.endsWith(".pdf");

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && isValidRfpFile(file)) {
      triggerUpload(file);
    } else {
      toast({ title: "Invalid file type", description: "Please upload an Excel, CSV, or PDF file", variant: "destructive" });
    }
  }, [triggerUpload, toast]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (isValidRfpFile(file)) {
        triggerUpload(file);
      } else {
        toast({ title: "Invalid file type", description: "Please upload an Excel, CSV, or PDF file", variant: "destructive" });
      }
    }
    e.target.value = "";
  }, [triggerUpload, toast]);

  const handleEditRfp = (rfp: Rfp) => {
    setEditingRfp(rfp);
    setRfpDialogOpen(true);
  };

  const handleAddRfp = () => {
    setEditingRfp(undefined);
    setRfpDialogOpen(true);
  };

  const handleEditAward = (award: Award) => {
    setEditingAward(award);
    setAwardDialogOpen(true);
  };

  const handleAddAward = () => {
    setEditingAward(undefined);
    setAwardDialogOpen(true);
  };

  const handleNewAwardCreated = (award: Award) => {
    const lanes = getHighVolumeLanes(award);
    if (lanes.length > 0) {
      setProcurementPromptAward(award);
      setProcurementPromptLanes(lanes);
    }
  };

  const handlePromptCreateTasks = async () => {
    if (!procurementPromptAward) return;
    setPromptGeneratingTasks(true);
    try {
      const res = await apiRequest("POST", `/api/awards/${procurementPromptAward.id}/procurement-tasks`, {});
      type LaneResult = { lane: string; taskId: string; created: boolean; failed?: boolean };
      const { results } = await res.json() as { results: LaneResult[] };
      const successResults = results.filter(r => !r.failed);
      const failedCount = results.filter(r => r.failed).length;
      const taskByLane = Object.fromEntries(successResults.map(r => [r.lane, r.taskId]));
      const createdLanes: ProcurementLaneInfo[] = procurementPromptLanes
        .map(lane => {
          const normalizedLane = lane.lane.trim().replace(/\s+/g, " ").toLowerCase();
          const taskId = taskByLane[normalizedLane] ?? taskByLane[lane.lane];
          return taskId ? { ...lane, taskId } : null;
        })
        .filter((l): l is ProcurementLaneInfo => l !== null);
      const createdCount = successResults.filter(r => r.created).length;
      if (createdCount > 0) {
        queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      }
      if (successResults.length > 0) {
        queryClient.invalidateQueries({ queryKey: ["/api/awards", procurementPromptAward.id, "procurement-tasks"] });
      }
      setPromptProcTitle(`Carrier Procurement — ${procurementPromptAward.title}`);
      setPromptProcLanes(createdLanes);
      setProcurementPromptAward(null);
      setProcurementPromptLanes([]);
      setPromptProcDialogOpen(true);
      if (failedCount > 0 && successResults.length > 0) {
        toast({
          title: `${successResults.length} task${successResults.length !== 1 ? "s" : ""} ready, ${failedCount} lane${failedCount !== 1 ? "s" : ""} failed`,
          description: "Workspace opened for successful lanes. Some lanes could not be set up — try again.",
        });
      } else {
        toast({
          title: createdCount > 0
            ? `${createdCount} procurement task${createdCount !== 1 ? "s" : ""} created`
            : "Opening procurement workspace",
          description: "Target 5–10 carrier contacts per lane.",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      let detail: string | undefined;
      try {
        const jsonPart = msg.replace(/^\d+:\s*/, "");
        detail = JSON.parse(jsonPart).error;
      } catch { /* ignore */ }
      toast({
        title: "Failed to generate procurement tasks",
        description: detail ?? "Please check the award has lanes in Origin → Destination format.",
        variant: "destructive",
      });
    } finally {
      setPromptGeneratingTasks(false);
    }
  };

  const isLoading = rfpsLoading || awardsLoading;

  const stats = {
    totalRfps: rfps?.length || 0,
    totalAwards: allAwards?.length || 0,
    rfpPipeline: rfps?.reduce((acc, r) => acc + (r.value ? parseFloat(r.value) : 0), 0) || 0,
    awardedValue: allAwards?.reduce((acc, a) => acc + (a.value ? parseFloat(a.value) : 0), 0) || 0,
    pendingRfps: rfps?.filter(r => r.status === "pending").length || 0,
    submittedRfps: rfps?.filter(r => r.status === "submitted").length || 0,
  };
  const lostOrDeclinedRfps = rfps?.filter(r => r.status === "lost" || r.status === "declined").length || 0;
  const winOpportunities = stats.totalAwards + lostOrDeclinedRfps;
  const winRate = winOpportunities > 0 ? Math.round((stats.totalAwards / winOpportunities) * 100) : null;

  return (
    <div className="flex flex-col gap-4 sm:gap-6 p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-rfp-awards-title">
            RFP & Awards
          </h1>
          <p className="text-muted-foreground">
            Manage your RFP submissions and awarded business separately
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleAddRfp} data-testid="button-add-rfp">
            <Plus className="h-4 w-4 mr-2" />
            Add RFP
          </Button>
          <Button onClick={handleAddAward} variant="outline" data-testid="button-add-award">
            <Plus className="h-4 w-4 mr-2" />
            Add Award
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card
          className="cursor-pointer hover:bg-accent/50 transition-colors"
          onClick={() => setDrilldownFilter("rfps")}
          data-testid="card-stat-active-rfps"
        >
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Active RFPs</p>
                <p className="text-2xl font-bold">{stats.totalRfps}</p>
              </div>
              <FileText className="h-8 w-8 text-muted-foreground/50" />
            </div>
          </CardContent>
        </Card>
        <Card
          className="cursor-pointer hover:bg-accent/50 transition-colors"
          onClick={() => setDrilldownFilter("awards")}
          data-testid="card-stat-awards-won"
        >
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Awards Won</p>
                <p className="text-2xl font-bold">{stats.totalAwards}</p>
              </div>
              <Trophy className="h-8 w-8 text-muted-foreground/50" />
            </div>
          </CardContent>
        </Card>
        <Card
          className="cursor-pointer hover:bg-accent/50 transition-colors"
          onClick={() => setDrilldownFilter("pipeline")}
          data-testid="card-stat-rfp-pipeline"
        >
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">RFP Pipeline</p>
                <p className="text-2xl font-bold">${(stats.rfpPipeline / 1000000).toFixed(1)}M</p>
              </div>
              <DollarSign className="h-8 w-8 text-muted-foreground/50" />
            </div>
          </CardContent>
        </Card>
        <Card
          className="cursor-pointer hover:bg-accent/50 transition-colors"
          onClick={() => setDrilldownFilter("awarded")}
          data-testid="card-stat-awarded-value"
        >
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Awarded Value</p>
                <p className="text-2xl font-bold text-green-600 dark:text-green-400">
                  ${(stats.awardedValue / 1000000).toFixed(1)}M
                </p>
              </div>
              <Trophy className="h-8 w-8 text-green-500/50" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Drill-Down Sheet */}
      <Sheet open={drilldownFilter !== null} onOpenChange={(open) => { if (!open) setDrilldownFilter(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-xl flex flex-col p-0" data-testid="sheet-drilldown">
          {(() => {
            const isRfpView = drilldownFilter === "rfps" || drilldownFilter === "pipeline";
            const isAwardView = drilldownFilter === "awards" || drilldownFilter === "awarded";
            const sortByValue = drilldownFilter === "pipeline" || drilldownFilter === "awarded";

            const titleMap = {
              rfps: "Active RFPs",
              pipeline: "RFP Pipeline",
              awards: "Awards Won",
              awarded: "Awarded Value",
            };
            const title = drilldownFilter ? titleMap[drilldownFilter] : "";

            const companyMap = new Map((companies || []).map((c) => [c.id, c]));

            let rfpRows = isRfpView ? [...(rfps || [])] : [];
            if (sortByValue && isRfpView) {
              rfpRows = rfpRows.sort((a, b) => (parseFloat(b.value || "0") - parseFloat(a.value || "0")));
            }
            const rfpTotal = rfpRows.reduce((acc, r) => acc + (r.value ? parseFloat(r.value) : 0), 0);

            let awardRows = isAwardView ? [...(allAwards || [])] : [];
            if (sortByValue && isAwardView) {
              awardRows = awardRows.sort((a, b) => (parseFloat(b.value || "0") - parseFloat(a.value || "0")));
            }
            const awardTotal = awardRows.reduce((acc, a) => acc + (a.value ? parseFloat(a.value) : 0), 0);

            const count = isRfpView ? rfpRows.length : awardRows.length;
            const totalValue = isRfpView ? rfpTotal : awardTotal;

            return (
              <>
                <div className="p-6 border-b">
                  <SheetHeader>
                    <SheetTitle className="text-xl" data-testid="text-drilldown-title">{title}</SheetTitle>
                  </SheetHeader>
                  <div className="flex items-center gap-6 mt-3">
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Count</p>
                      <p className="text-2xl font-bold" data-testid="text-drilldown-count">{count}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Value</p>
                      <p className="text-2xl font-bold" data-testid="text-drilldown-value">
                        ${totalValue >= 1_000_000 ? `${(totalValue / 1_000_000).toFixed(1)}M` : totalValue.toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {isRfpView && (() => {
                    if (rfpsLoading) {
                      return (
                        <div className="space-y-3" data-testid="skeleton-drilldown-loading">
                          {[1, 2, 3].map((i) => (
                            <div key={i} className="space-y-1.5">
                              <div className="flex items-center gap-2">
                                <Skeleton className="h-8 w-8 rounded-full" />
                                <div className="space-y-1 flex-1">
                                  <Skeleton className="h-4 w-32" />
                                  <Skeleton className="h-3 w-20" />
                                </div>
                              </div>
                              <div className="pl-10 space-y-1.5">
                                <Skeleton className="h-16 w-full rounded-lg" />
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    }
                    if (rfpRows.length === 0) {
                      return (
                        <div className="text-center py-12 text-muted-foreground" data-testid="text-drilldown-empty">
                          <FileText className="h-10 w-10 mx-auto mb-2 opacity-30" />
                          <p>No RFPs found</p>
                        </div>
                      );
                    }
                    const grouped: Map<string, typeof rfpRows> = new Map();
                    for (const rfp of rfpRows) {
                      const key = rfp.companyId || "__none__";
                      if (!grouped.has(key)) grouped.set(key, []);
                      grouped.get(key)!.push(rfp);
                    }
                    const groupEntries = Array.from(grouped.entries()).map(([companyId, rows]) => {
                      const company = companyId !== "__none__" ? companyMap.get(companyId) : undefined;
                      const groupTotal = rows.reduce((acc, r) => acc + (r.value ? parseFloat(r.value) : 0), 0);
                      return { companyId, company, rows, groupTotal };
                    });
                    if (sortByValue) {
                      groupEntries.sort((a, b) => b.groupTotal - a.groupTotal);
                    } else {
                      groupEntries.sort((a, b) => (a.company?.name || "").localeCompare(b.company?.name || ""));
                    }
                    return groupEntries.map(({ companyId, company, rows, groupTotal }) => {
                      const initials = company ? company.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase() : "?";
                      return (
                        <div key={companyId} data-testid={`group-drilldown-company-${companyId}`}>
                          <div className="flex items-center gap-2 mb-2">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold">
                              {initials}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-sm truncate">{company?.name || "Unknown Customer"}</p>
                              <p className="text-xs text-muted-foreground">{rows.length} {rows.length === 1 ? "RFP" : "RFPs"}{groupTotal > 0 ? ` · $${Number(groupTotal).toLocaleString()}` : ""}</p>
                            </div>
                          </div>
                          <div className="space-y-1.5 pl-10">
                            {rows.map((rfp) => {
                              const statusCfg = rfpStatusConfig[rfp.status as keyof typeof rfpStatusConfig] || rfpStatusConfig.pending;
                              const StatusIcon = statusCfg.icon;
                              return (
                                <div
                                  key={rfp.id}
                                  className="flex items-start gap-3 p-3 rounded-lg border bg-card"
                                  data-testid={`row-drilldown-rfp-${rfp.id}`}
                                >
                                  <div className="flex-1 min-w-0">
                                    <p className="font-medium text-sm truncate">{rfp.title}</p>
                                    <div className="flex flex-wrap items-center gap-2 mt-1">
                                      <Badge className={`${statusCfg.color} text-xs`}>
                                        <StatusIcon className="h-3 w-3 mr-1" />
                                        {statusCfg.label}
                                      </Badge>
                                      {rfp.dueDate && (
                                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                                          <Calendar className="h-3 w-3" />
                                          {new Date(rfp.dueDate).toLocaleDateString()}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="shrink-0 text-right">
                                    {rfp.value && (
                                      <p className="font-semibold text-sm">${Number(rfp.value).toLocaleString()}</p>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    });
                  })()}

                  {isAwardView && (() => {
                    if (awardsLoading) {
                      return (
                        <div className="space-y-3" data-testid="skeleton-drilldown-loading">
                          {[1, 2, 3].map((i) => (
                            <div key={i} className="space-y-1.5">
                              <div className="flex items-center gap-2">
                                <Skeleton className="h-8 w-8 rounded-full" />
                                <div className="space-y-1 flex-1">
                                  <Skeleton className="h-4 w-32" />
                                  <Skeleton className="h-3 w-20" />
                                </div>
                              </div>
                              <div className="pl-10 space-y-1.5">
                                <Skeleton className="h-16 w-full rounded-lg" />
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    }
                    if (awardRows.length === 0) {
                      return (
                        <div className="text-center py-12 text-muted-foreground" data-testid="text-drilldown-empty">
                          <Trophy className="h-10 w-10 mx-auto mb-2 opacity-30" />
                          <p>No awards found</p>
                        </div>
                      );
                    }
                    const grouped: Map<string, typeof awardRows> = new Map();
                    for (const award of awardRows) {
                      const key = award.companyId || "__none__";
                      if (!grouped.has(key)) grouped.set(key, []);
                      grouped.get(key)!.push(award);
                    }
                    const groupEntries = Array.from(grouped.entries()).map(([companyId, rows]) => {
                      const company = companyId !== "__none__" ? companyMap.get(companyId) : undefined;
                      const groupTotal = rows.reduce((acc, a) => acc + (a.value ? parseFloat(a.value) : 0), 0);
                      return { companyId, company, rows, groupTotal };
                    });
                    if (sortByValue) {
                      groupEntries.sort((a, b) => b.groupTotal - a.groupTotal);
                    } else {
                      groupEntries.sort((a, b) => (a.company?.name || "").localeCompare(b.company?.name || ""));
                    }
                    return groupEntries.map(({ companyId, company, rows, groupTotal }) => {
                      const initials = company ? company.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase() : "?";
                      return (
                        <div key={companyId} data-testid={`group-drilldown-award-company-${companyId}`}>
                          <div className="flex items-center gap-2 mb-2">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-500/10 text-green-600 dark:text-green-400 text-xs font-bold">
                              {initials}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-sm truncate">{company?.name || "Unknown Customer"}</p>
                              <p className="text-xs text-muted-foreground">{rows.length} {rows.length === 1 ? "award" : "awards"}{groupTotal > 0 ? ` · $${Number(groupTotal).toLocaleString()}` : ""}</p>
                            </div>
                          </div>
                          <div className="space-y-1.5 pl-10">
                            {rows.map((award) => (
                              <div
                                key={award.id}
                                className="flex items-start gap-3 p-3 rounded-lg border bg-card"
                                data-testid={`row-drilldown-award-${award.id}`}
                              >
                                <div className="flex-1 min-w-0">
                                  <p className="font-medium text-sm truncate">{award.title}</p>
                                  <div className="flex flex-wrap items-center gap-2 mt-1">
                                    {award.awardDate && (
                                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                                        <Calendar className="h-3 w-3" />
                                        {new Date(award.awardDate).toLocaleDateString()}
                                      </span>
                                    )}
                                    {award.lanes && award.lanes.length > 0 && (
                                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                                        <TruckIcon className="h-3 w-3" />
                                        {award.lanes.length} {award.lanes.length === 1 ? "lane" : "lanes"}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="shrink-0 text-right">
                                  {award.value && (
                                    <p className="font-semibold text-sm text-green-600 dark:text-green-400">
                                      ${Number(award.value).toLocaleString()}
                                    </p>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </>
            );
          })()}
        </SheetContent>
      </Sheet>

      {/* Win/Loss Summary Bar */}
      {(stats.totalRfps > 0 || stats.totalAwards > 0) && (
        <Card data-testid="card-win-loss-summary">
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Pipeline Summary</span>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-yellow-400 inline-block" />
                  <span className="text-muted-foreground">Pending:</span>
                  <span className="font-semibold">{stats.pendingRfps}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-blue-400 inline-block" />
                  <span className="text-muted-foreground">Submitted:</span>
                  <span className="font-semibold">{stats.submittedRfps}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-green-500 inline-block" />
                  <span className="text-muted-foreground">Awarded:</span>
                  <span className="font-semibold">{stats.totalAwards}</span>
                </div>
                {winRate !== null && (
                  <div className="flex items-center gap-1.5 border-l pl-4 ml-1">
                    <Trophy className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                    <span className="text-muted-foreground">Win Rate:</span>
                    <span className={`font-bold ${winRate >= 50 ? "text-green-600 dark:text-green-400" : winRate >= 25 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"}`}>{winRate}%</span>
                    <span className="text-xs text-muted-foreground">({stats.totalAwards} awarded / {winOpportunities} decided)</span>
                  </div>
                )}
              </div>
            </div>
            {winOpportunities > 0 && (
              <div className="mt-3 flex h-2 w-full rounded-full overflow-hidden gap-px">
                <div className="bg-green-500" style={{ width: `${(stats.totalAwards / (stats.totalRfps + stats.totalAwards)) * 100}%` }} />
                <div className="bg-blue-400" style={{ width: `${(stats.submittedRfps / (stats.totalRfps + stats.totalAwards)) * 100}%` }} />
                <div className="bg-yellow-400" style={{ width: `${(stats.pendingRfps / (stats.totalRfps + stats.totalAwards)) * 100}%` }} />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card
        className={`border-2 border-dashed transition-colors ${isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25"}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        data-testid="rfp-upload-dropzone"
      >
        <CardContent className="p-6">
          <div
            className="flex flex-col items-center gap-4"
          >
            <div className={`rounded-full p-4 transition-colors ${isDragging ? "bg-primary/10" : (uploadMutation.isPending || previewHeadersMutation.isPending) ? "bg-green-100 dark:bg-green-900/30" : "bg-muted"}`}>
              {(uploadMutation.isPending || previewHeadersMutation.isPending) ? (
                <Loader2 className="h-8 w-8 text-green-600 dark:text-green-400 animate-spin" />
              ) : (
                <Upload className={`h-8 w-8 ${isDragging ? "text-primary" : "text-muted-foreground"}`} />
              )}
            </div>
            <div className="text-center">
              <h3 className="font-medium mb-1">
                {previewHeadersMutation.isPending
                  ? (pendingFile?.name.endsWith(".pdf") ? "Reading PDF & extracting lanes..." : "Analyzing columns...")
                  : uploadMutation.isPending || uploadPdfMutation.isPending
                    ? "Uploading & Analyzing..."
                    : "Upload RFP File"}
              </h3>
              <p className="text-sm text-muted-foreground mb-3">
                Drag and drop an Excel, CSV, or PDF file — AI will extract lane data automatically
              </p>
            </div>
            {pendingFile && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-sm w-full max-w-md">
                {pendingFile.name.endsWith(".pdf") ? (
                  <FileText className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
                ) : (
                  <FileSpreadsheet className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
                )}
                <span className="truncate flex-1 text-amber-800 dark:text-amber-300 font-medium">{pendingFile.name}</span>
                <button onClick={() => setPendingFile(null)} className="text-amber-500 hover:text-amber-700 shrink-0" data-testid="button-clear-pending-file">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            <div className="flex items-center gap-3 w-full max-w-md">
              <Select value={uploadCompanyId} onValueChange={(val) => {
                setUploadCompanyId(val);
                if (pendingFile && val) {
                  previewHeadersMutation.mutate({ file: pendingFile });
                }
              }}>
                <SelectTrigger className="flex-1" data-testid="select-upload-company">
                  <SelectValue placeholder="Select company for upload" />
                </SelectTrigger>
                <SelectContent>
                  {companies?.map((company) => (
                    <SelectItem key={company.id} value={company.id}>
                      {company.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label>
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv,.pdf"
                  onChange={handleFileSelect}
                  className="hidden"
                  disabled={uploadMutation.isPending || previewHeadersMutation.isPending}
                  data-testid="input-file-upload"
                />
                <Button
                  variant="outline"
                  disabled={uploadMutation.isPending || previewHeadersMutation.isPending}
                  asChild
                >
                  <span className="cursor-pointer">
                    <FileSpreadsheet className="h-4 w-4 mr-2" />
                    Browse
                  </span>
                </Button>
              </label>
            </div>
            {pendingFile && !uploadCompanyId && (
              <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                File ready — now select a customer above to upload
              </p>
            )}
            {!pendingFile && !uploadCompanyId && (
              <p className="text-xs text-muted-foreground">
                You can drop a file first, then choose the customer
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search RFPs and awards..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
          data-testid="input-search-rfps"
        />
      </div>

      {/* PDF Extracted Lanes Review Dialog */}
      <Dialog open={pdfPreviewOpen} onOpenChange={(open) => {
        if (!open) {
          setPdfPreviewOpen(false);
          setPdfExtractedLanes([]);
          setPdfRfpType("");
        }
      }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto" data-testid="dialog-pdf-review">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              AI-Extracted Lanes from PDF
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              GPT-4o read <span className="font-medium">{pendingFile?.name}</span> and extracted the following freight lanes.
              Review them, then confirm to create the RFP.
            </p>
          </DialogHeader>

          {pdfExtractedLanes.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center text-muted-foreground">
              <AlertTriangle className="h-8 w-8 text-amber-500" />
              <div>
                <p className="font-medium text-foreground">No lanes found</p>
                <p className="text-sm mt-1">The AI could not find structured lane data in this PDF. The document may use a format the AI couldn't parse, or it may not contain lane-level data.</p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 p-3 rounded-md bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 text-sm text-green-800 dark:text-green-300" data-testid="status-pdf-lanes-found">
                <CheckCircle className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
                <span>{pdfExtractedLanes.length} lane{pdfExtractedLanes.length !== 1 ? "s" : ""} extracted — review before confirming</span>
              </div>

              <div className="border rounded-md overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-pdf-lanes">
                  <thead>
                    <tr className="bg-muted/50 border-b">
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Origin</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Destination</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Volume</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Equipment</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Lane ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pdfExtractedLanes.map((lane, idx) => (
                      <tr key={idx} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-3 py-2 whitespace-nowrap">
                          {[lane.origin_city, lane.origin_state, lane.origin_zip].filter(Boolean).join(", ") || <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {[lane.dest_city, lane.dest_state, lane.dest_zip].filter(Boolean).join(", ") || <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2">
                          {lane.volume != null ? Number(lane.volume).toLocaleString() : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2">{lane.equipment || <span className="text-muted-foreground">—</span>}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{lane.lane_id || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* RFP Type */}
          <div className="p-3 rounded-md border border-border bg-muted/30">
            <p className="text-sm font-medium mb-2">
              RFP Type <span className="text-destructive">*</span>
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setPdfRfpType("mini_bid")}
                className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-md border text-sm font-medium transition-colors ${pdfRfpType === "mini_bid" ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted text-muted-foreground"}`}
                data-testid="button-pdf-rfp-type-mini-bid"
              >
                Mini Bid
              </button>
              <button
                type="button"
                onClick={() => setPdfRfpType("full_rfp")}
                className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-md border text-sm font-medium transition-colors ${pdfRfpType === "full_rfp" ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted text-muted-foreground"}`}
                data-testid="button-pdf-rfp-type-full-rfp"
              >
                Full RFP
              </button>
            </div>
            {!pdfRfpType && (
              <p className="text-xs text-destructive mt-1">Please select a type to proceed.</p>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="outline" onClick={() => { setPdfPreviewOpen(false); setPdfExtractedLanes([]); setPdfRfpType(""); }} data-testid="button-cancel-pdf">
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (uploadCompanyId && pdfRfpType && pendingFile) {
                  uploadPdfMutation.mutate({
                    companyId: uploadCompanyId,
                    rfpType: pdfRfpType,
                    lanes: pdfExtractedLanes,
                    fileName: pendingFile.name,
                  });
                }
              }}
              disabled={uploadPdfMutation.isPending || !pdfRfpType || pdfExtractedLanes.length === 0}
              data-testid="button-confirm-pdf"
            >
              {uploadPdfMutation.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving...</>
              ) : (
                <><CheckCircle className="h-4 w-4 mr-2" />Confirm & Create RFP</>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Column Mapping Dialog */}
      {columnMappingData && (
        <Dialog open={columnMappingOpen} onOpenChange={(open) => {
          if (!open) {
            setColumnMappingOpen(false);
            setColumnMappingData(null);
            setConfirmedMapping({});
            setUploadRfpType("");
          }
        }}>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="dialog-column-mapping">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                Confirm Column Mapping
              </DialogTitle>
              <p className="text-sm text-muted-foreground">
                AI has detected the following column mappings from{" "}
                <span className="font-medium">{pendingFile?.name}</span>
                {columnMappingData.sheetName ? ` (tab: "${columnMappingData.sheetName}")` : ""}. Review and adjust as needed.
              </p>
              {columnMappingData.confident ? (
                <Badge variant="outline" className="w-fit text-green-700 dark:text-green-400 border-green-300 dark:border-green-700" data-testid="badge-ai-confidence-high">
                  <Sparkles className="h-3 w-3 mr-1" />
                  High confidence
                </Badge>
              ) : (
                <Badge variant="outline" className="w-fit text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-700" data-testid="badge-ai-confidence-low">
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Low confidence — please review carefully
                </Badge>
              )}
            </DialogHeader>

            {/* Required field validation */}
            {(() => {
              const mappedFields = Object.values(confirmedMapping);
              const hasOrigin = mappedFields.some(f => f.startsWith("origin_"));
              const hasDestination = mappedFields.some(f => f.startsWith("dest_"));
              const hasVolume = mappedFields.includes("volume");
              const missing: string[] = [];
              if (!hasOrigin) missing.push("origin");
              if (!hasDestination) missing.push("destination");
              if (!hasVolume) missing.push("volume");
              if (missing.length > 0) {
                return (
                  <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-sm text-amber-800 dark:text-amber-300" data-testid="warning-missing-fields">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                    <span>
                      Missing required field{missing.length > 1 ? "s" : ""}: <strong>{missing.join(", ")}</strong>.
                      You can still proceed, but lane analysis may be incomplete.
                    </span>
                  </div>
                );
              }
              return (
                <div className="flex items-center gap-2 p-3 rounded-md bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 text-sm text-green-800 dark:text-green-300" data-testid="status-mapping-complete">
                  <CheckCircle className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
                  <span>All required fields mapped. Ready to confirm.</span>
                </div>
              );
            })()}

            {/* RFP Type Selection */}
            <div className="p-3 rounded-md border border-border bg-muted/30">
              <p className="text-sm font-medium mb-2">
                RFP Type <span className="text-destructive">*</span>
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setUploadRfpType("mini_bid")}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-md border text-sm font-medium transition-colors ${uploadRfpType === "mini_bid" ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted text-muted-foreground"}`}
                  data-testid="button-rfp-type-mini-bid"
                >
                  Mini Bid
                </button>
                <button
                  type="button"
                  onClick={() => setUploadRfpType("full_rfp")}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-md border text-sm font-medium transition-colors ${uploadRfpType === "full_rfp" ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted text-muted-foreground"}`}
                  data-testid="button-rfp-type-full-rfp"
                >
                  Full RFP
                </button>
              </div>
              {!uploadRfpType && (
                <p className="text-xs text-destructive mt-1" data-testid="error-rfp-type-required">Please select a type to proceed.</p>
              )}
            </div>

            <div className="space-y-1">
              <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center text-xs font-medium text-muted-foreground px-1 pb-1">
                <span>Spreadsheet Column</span>
                <span />
                <span>Maps To</span>
              </div>
              {columnMappingData.headers.map((header) => {
                const samples = columnMappingData.columnSamples[header] || [];
                return (
                  <div
                    key={header}
                    className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center p-2 rounded-md hover:bg-muted/50 transition-colors"
                    data-testid={`row-column-mapping-${header}`}
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{header}</p>
                      {samples.length > 0 && (
                        <p className="text-xs text-muted-foreground truncate">
                          e.g. {samples.slice(0, 2).join(", ")}
                        </p>
                      )}
                    </div>
                    <ArrowRightLeft className="h-4 w-4 text-muted-foreground shrink-0" />
                    <Select
                      value={confirmedMapping[header] || "ignore"}
                      onValueChange={(val) => setConfirmedMapping(prev => ({ ...prev, [header]: val }))}
                    >
                      <SelectTrigger className="text-sm h-9" data-testid={`select-mapping-${header}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="origin_city">Origin City</SelectItem>
                        <SelectItem value="origin_state">Origin State</SelectItem>
                        <SelectItem value="origin_zip">Origin ZIP</SelectItem>
                        <SelectItem value="dest_city">Destination City</SelectItem>
                        <SelectItem value="dest_state">Destination State</SelectItem>
                        <SelectItem value="dest_zip">Destination ZIP</SelectItem>
                        <SelectItem value="volume">Volume (loads)</SelectItem>
                        <SelectItem value="equipment">Equipment Type</SelectItem>
                        <SelectItem value="lane_id">Lane ID</SelectItem>
                        <SelectItem value="miles">Miles / Distance</SelectItem>
                        <SelectItem value="ignore">Ignore</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button
                variant="outline"
                onClick={() => {
                  setColumnMappingOpen(false);
                  setColumnMappingData(null);
                  setConfirmedMapping({});
                  setUploadRfpType("");
                }}
                data-testid="button-cancel-mapping"
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  if (pendingFile && uploadCompanyId && uploadRfpType) {
                    uploadMutation.mutate({ file: pendingFile, companyId: uploadCompanyId, mapping: confirmedMapping, rfpType: uploadRfpType });
                  }
                }}
                disabled={uploadMutation.isPending || !uploadRfpType}
                data-testid="button-confirm-mapping"
              >
                {uploadMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Confirm & Upload
                  </>
                )}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {viewingRfp && (
        <RfpDataViewer
          rfp={rfps?.find(r => r.id === viewingRfp.id) || viewingRfp}
          companyId={viewingRfp.companyId}
          onClose={() => setViewingRfp(null)}
          onRfpUpdated={() => {
            queryClient.invalidateQueries({ queryKey: ["/api/rfps"] });
          }}
        />
      )}

      <ConvertToAwardDialog
        rfp={convertingRfp}
        company={convertingRfp ? companiesMap.get(convertingRfp.companyId) : undefined}
        onClose={() => setConvertingRfp(null)}
        onCreated={handleNewAwardCreated}
      />

      {isLoading ? (
        <div className="space-y-8">
          <div>
            <Skeleton className="h-8 w-32 mb-4" />
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[1, 2].map((i) => (
                <Card key={i}>
                  <CardContent className="p-4">
                    <Skeleton className="h-6 w-3/4 mb-3" />
                    <Skeleton className="h-4 w-1/2 mb-2" />
                    <Skeleton className="h-4 w-1/3" />
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-8">

          {/* RFP Deadline Timeline */}
          {(() => {
            const now = Date.now();
            const upcomingRfps = [...(rfps ?? [])]
              .filter(r => r.dueDate && (r.status === "open" || r.status === "pending"))
              .map(r => {
                const daysLeft = Math.ceil((new Date(r.dueDate!).getTime() - now) / 86400000);
                return { ...r, daysLeft };
              })
              .sort((a, b) => a.daysLeft - b.daysLeft)
              .slice(0, 6);

            if (upcomingRfps.length === 0) return null;
            return (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Deadline Timeline</h2>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {upcomingRfps.map(rfp => {
                    const isOverdue = rfp.daysLeft < 0;
                    const isUrgent = rfp.daysLeft >= 0 && rfp.daysLeft <= 7;
                    const isWarning = rfp.daysLeft > 7 && rfp.daysLeft <= 14;
                    const colorCls = isOverdue
                      ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30"
                      : isUrgent
                        ? "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"
                        : isWarning
                          ? "border-yellow-200 bg-yellow-50/60 dark:border-yellow-800 dark:bg-yellow-950/20"
                          : "border-border bg-card";
                    const textCls = isOverdue ? "text-red-600 dark:text-red-400" : isUrgent ? "text-amber-600 dark:text-amber-400" : isWarning ? "text-yellow-600 dark:text-yellow-500" : "text-muted-foreground";
                    const label = isOverdue ? `${Math.abs(rfp.daysLeft)}d overdue` : rfp.daysLeft === 0 ? "Due today" : `${rfp.daysLeft}d left`;
                    const co = companiesMap.get(rfp.companyId);
                    return (
                      <div key={rfp.id} className={`rounded-lg border px-3 py-2.5 flex items-center gap-3 ${colorCls}`} data-testid={`rfp-deadline-${rfp.id}`}>
                        <div className="shrink-0">
                          {isOverdue ? (
                            <AlertTriangle className="h-4 w-4 text-red-500" />
                          ) : isUrgent ? (
                            <Clock className="h-4 w-4 text-amber-500" />
                          ) : (
                            <Calendar className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold truncate">{rfp.title}</p>
                          {co && <p className="text-xs text-muted-foreground truncate">{co.name}</p>}
                        </div>
                        <div className={`text-xs font-bold tabular-nums shrink-0 ${textCls}`}>{label}</div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })()}

          <section>
            <div className="flex items-center gap-2 mb-4">
              <FileText className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold" data-testid="text-rfp-section-title">
                RFPs
              </h2>
              <Badge variant="secondary" className="ml-1">
                {filteredRfps.length}
              </Badge>
            </div>

            {filteredRfps.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {filteredRfps.map((rfp) => (
                  <RfpCard
                    key={rfp.id}
                    rfp={rfp}
                    company={companiesMap.get(rfp.companyId)}
                    onEdit={handleEditRfp}
                    onDelete={setDeleteRfpTarget}
                    onViewData={setViewingRfp}
                    onConvert={setConvertingRfp}
                  />
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-8">
                  <FileText className="h-10 w-10 text-muted-foreground/50 mb-3" />
                  <h3 className="font-medium mb-1">No RFPs</h3>
                  <p className="text-sm text-muted-foreground text-center max-w-sm">
                    {searchQuery
                      ? "No RFPs match your search"
                      : "Add an RFP manually or upload an Excel spreadsheet"}
                  </p>
                  {!searchQuery && (
                    <Button onClick={handleAddRfp} className="mt-3" size="sm" data-testid="button-add-first-rfp">
                      <Plus className="h-4 w-4 mr-2" />
                      Add RFP
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}
          </section>

          <section>
            <div className="flex items-center gap-2 mb-4">
              <Trophy className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold" data-testid="text-awards-section-title">
                Awards
              </h2>
              <Badge variant="secondary" className="ml-1">
                {filteredAwards.length}
              </Badge>
            </div>

            {filteredAwards.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {filteredAwards.map((award) => (
                  <AwardCard
                    key={award.id}
                    award={award}
                    company={companiesMap.get(award.companyId)}
                    onEdit={handleEditAward}
                    onDelete={setDeleteAwardTarget}
                  />
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-8">
                  <Trophy className="h-10 w-10 text-muted-foreground/50 mb-3" />
                  <h3 className="font-medium mb-1">No awards yet</h3>
                  <p className="text-sm text-muted-foreground text-center max-w-sm">
                    {searchQuery
                      ? "No awards match your search"
                      : "Record your won business here"}
                  </p>
                  {!searchQuery && (
                    <Button onClick={handleAddAward} className="mt-3" size="sm" variant="outline" data-testid="button-add-first-award">
                      <Plus className="h-4 w-4 mr-2" />
                      Add Award
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}
          </section>
        </div>
      )}

      <RfpDialog
        open={rfpDialogOpen}
        onOpenChange={(open) => {
          setRfpDialogOpen(open);
          if (!open) setEditingRfp(undefined);
        }}
        rfp={editingRfp}
      />

      <AwardDialog
        open={awardDialogOpen}
        onOpenChange={(open) => {
          setAwardDialogOpen(open);
          if (!open) setEditingAward(undefined);
        }}
        award={editingAward}
        onCreated={handleNewAwardCreated}
      />

      {/* Procurement prompt — shown after a new award is created with high-volume lanes */}
      <Dialog open={!!procurementPromptAward} onOpenChange={(open) => { if (!open) { setProcurementPromptAward(null); setProcurementPromptLanes([]); } }}>
        <DialogContent className="sm:max-w-sm" data-testid="dialog-procurement-prompt">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trophy className="h-5 w-5 text-amber-500" />
              Set up carrier procurement?
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-1">
            <p className="text-sm text-muted-foreground leading-relaxed">
              <span className="font-medium text-foreground">{procurementPromptAward?.title}</span> has{" "}
              <span className="font-medium text-foreground">{procurementPromptLanes.length} high-volume lane{procurementPromptLanes.length !== 1 ? "s" : ""}</span> (50+ loads/year).
              Want to create procurement tasks so your team can start sourcing carrier coverage?
            </p>
            <p className="text-xs text-muted-foreground">
              You can always do this later from the award card.
            </p>
            <div className="flex flex-col gap-2 pt-1">
              <Button
                onClick={handlePromptCreateTasks}
                disabled={promptGeneratingTasks}
                className="w-full"
                data-testid="button-prompt-create-tasks"
              >
                {promptGeneratingTasks ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Creating tasks…</>
                ) : (
                  <><ClipboardList className="h-4 w-4 mr-2" />Yes, create procurement tasks</>
                )}
              </Button>
              <Button
                variant="ghost"
                onClick={() => { setProcurementPromptAward(null); setProcurementPromptLanes([]); }}
                className="w-full text-muted-foreground"
                data-testid="button-prompt-skip-procurement"
              >
                Skip for now
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Workspace dialog opened from the procurement prompt */}
      {promptProcLanes.length > 0 && (
        <ProcurementTaskLauncherDialog
          open={promptProcDialogOpen}
          onOpenChange={(open) => {
            setPromptProcDialogOpen(open);
            if (!open) { setPromptProcLanes([]); setPromptProcTitle(""); }
          }}
          title={promptProcTitle}
          lanes={promptProcLanes}
        />
      )}

      <AlertDialog open={!!deleteRfpTarget} onOpenChange={(open) => !open && setDeleteRfpTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete RFP</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteRfpTarget?.title}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-rfp">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteRfpTarget && deleteRfpMutation.mutate(deleteRfpTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-rfp"
            >
              {deleteRfpMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteAwardTarget} onOpenChange={(open) => !open && setDeleteAwardTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Award</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteAwardTarget?.title}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-award">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteAwardTarget && deleteAwardMutation.mutate(deleteAwardTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-award"
            >
              {deleteAwardMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
