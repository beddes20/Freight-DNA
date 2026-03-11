import { useState, useCallback } from "react";
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
import { RfpDialog } from "@/components/rfp-dialog";
import { AwardDialog } from "@/components/award-dialog";
import { ResearchLaneDialog } from "@/components/research-lane-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Rfp, Award, Company } from "@shared/schema";

const rfpStatusConfig = {
  pending: { label: "Pending", icon: Clock, color: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400" },
  submitted: { label: "Submitted", icon: Send, color: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
};

interface RfpCardProps {
  rfp: Rfp;
  company?: Company;
  onEdit: (rfp: Rfp) => void;
  onDelete: (rfp: Rfp) => void;
  onViewData: (rfp: Rfp) => void;
}

function RfpCard({ rfp, company, onEdit, onDelete, onViewData }: RfpCardProps) {
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
          <Badge className={status.color}>
            <StatusIcon className="h-3 w-3 mr-1" />
            {status.label}
          </Badge>
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

        <div className="flex items-center justify-end gap-1 mt-3 pt-3 border-t">
          {rfp.fileData && (
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
      </CardContent>
    </Card>
  );
}

interface AwardCardProps {
  award: Award;
  company?: Company;
  onEdit: (award: Award) => void;
  onDelete: (award: Award) => void;
}

function AwardCard({ award, company, onEdit, onDelete }: AwardCardProps) {
  return (
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
          <Badge className="bg-green-500/10 text-green-600 dark:text-green-400">
            <Trophy className="h-3 w-3 mr-1" />
            Won
          </Badge>
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

        <div className="flex items-center justify-end gap-1 mt-3 pt-3 border-t">
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
      </CardContent>
    </Card>
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
  status?: string;
  contactId?: string;
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

  const fileDataObj = rfp.fileData as { rows?: Record<string, any>[]; highVolumeLanes?: HighVolumeLane[] } | Record<string, any>[] | null;

  let rows: Record<string, any>[] = [];
  let highVolumeLanes: HighVolumeLane[] = [];

  if (Array.isArray(fileDataObj)) {
    rows = fileDataObj;
  } else if (fileDataObj && typeof fileDataObj === "object") {
    rows = fileDataObj.rows || [];
    highVolumeLanes = fileDataObj.highVolumeLanes || [];
  }

  if (rows.length === 0 && highVolumeLanes.length === 0) return null;
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];

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
      {highVolumeLanes.length > 0 && (
        <Card className="border-2 border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
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
              </div>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              These lanes have more than 50 annual loads. Assign a planner to research who owns each lane.
            </p>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm" data-testid="table-high-volume-lanes">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">Lane</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">Volume</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">Rate</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">Status</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {highVolumeLanes.map((lane, i) => (
                    <tr
                      key={i}
                      className={`border-b last:border-0 transition-colors ${
                        lane.status && lane.status !== "open"
                          ? "bg-green-50/50 dark:bg-green-950/10"
                          : "hover:bg-muted/30"
                      }`}
                      data-testid={`high-volume-lane-${i}`}
                    >
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <TruckIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          <span className="font-medium">{lane.lane}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {lane.volume.toLocaleString()} / yr
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {lane.rate || "—"}
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
                            onClick={() => handleAssign(lane, i)}
                            data-testid={`button-assign-lane-${i}`}
                          >
                            <UserPlus className="h-4 w-4 mr-1" />
                            Assign Lane to Planner
                          </Button>
                        ) : lane.status === "contact_added" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-green-300 text-green-700 hover:bg-green-100 dark:border-green-700 dark:text-green-400 dark:hover:bg-green-900/30"
                            onClick={() => markResearchedMutation.mutate({ laneIdx: i })}
                            disabled={markResearchedMutation.isPending}
                            data-testid={`button-mark-researched-${i}`}
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
          </CardContent>
        </Card>
      )}

      <Card className="border-2 border-primary/20">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="h-4 w-4" />
                {rfp.title} - Spreadsheet Data
              </CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {rfp.fileName} - {rows.length} rows
              </p>
            </div>
            <Button size="icon" variant="ghost" onClick={onClose} data-testid="button-close-data-viewer">
              <X className="h-4 w-4" />
            </Button>
          </div>

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
        </CardHeader>
        {rows.length > 0 && (
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

      <ResearchLaneDialog
        open={researchDialogOpen}
        onOpenChange={setResearchDialogOpen}
        lane={selectedLane}
        laneIndex={selectedLaneIndex}
        rfpId={rfp.id}
        companyId={companyId}
      />
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
  const [deleteRfpTarget, setDeleteRfpTarget] = useState<Rfp | null>(null);
  const [deleteAwardTarget, setDeleteAwardTarget] = useState<Award | null>(null);
  const [viewingRfp, setViewingRfp] = useState<Rfp | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploadCompanyId, setUploadCompanyId] = useState("");

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
    mutationFn: async ({ file, companyId }: { file: File; companyId: string }) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("companyId", companyId);
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
      toast({
        title: "RFP uploaded successfully",
        description: `Analyzed ${data.analysis.laneCount} lanes from ${data.rfp.fileName}`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    },
  });

  const triggerUpload = useCallback((file: File) => {
    if (!uploadCompanyId) {
      setPendingFile(file);
    } else {
      uploadMutation.mutate({ file, companyId: uploadCompanyId });
    }
  }, [uploadCompanyId, uploadMutation]);

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

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith(".xlsx") || file.name.endsWith(".xls") || file.name.endsWith(".csv"))) {
      triggerUpload(file);
    } else {
      toast({ title: "Invalid file type", description: "Please upload an Excel (.xlsx, .xls) or CSV file", variant: "destructive" });
    }
  }, [triggerUpload, toast]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.name.endsWith(".xlsx") || file.name.endsWith(".xls") || file.name.endsWith(".csv")) {
        triggerUpload(file);
      } else {
        toast({ title: "Invalid file type", description: "Please upload an Excel (.xlsx, .xls) or CSV file", variant: "destructive" });
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

  const isLoading = rfpsLoading || awardsLoading;

  const stats = {
    totalRfps: rfps?.length || 0,
    totalAwards: allAwards?.length || 0,
    rfpPipeline: rfps?.reduce((acc, r) => acc + (r.value ? parseFloat(r.value) : 0), 0) || 0,
    awardedValue: allAwards?.reduce((acc, a) => acc + (a.value ? parseFloat(a.value) : 0), 0) || 0,
  };

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
        <Card>
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
        <Card>
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
        <Card>
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
        <Card>
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
            <div className={`rounded-full p-4 transition-colors ${isDragging ? "bg-primary/10" : uploadMutation.isPending ? "bg-green-100 dark:bg-green-900/30" : "bg-muted"}`}>
              {uploadMutation.isPending ? (
                <Loader2 className="h-8 w-8 text-green-600 dark:text-green-400 animate-spin" />
              ) : (
                <Upload className={`h-8 w-8 ${isDragging ? "text-primary" : "text-muted-foreground"}`} />
              )}
            </div>
            <div className="text-center">
              <h3 className="font-medium mb-1">
                {uploadMutation.isPending ? "Uploading & Analyzing..." : "Upload RFP Spreadsheet"}
              </h3>
              <p className="text-sm text-muted-foreground mb-3">
                Drag and drop an Excel or CSV file here to create an RFP with data analysis
              </p>
            </div>
            {pendingFile && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-sm w-full max-w-md">
                <FileSpreadsheet className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
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
                  uploadMutation.mutate({ file: pendingFile, companyId: val });
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
                  accept=".xlsx,.xls,.csv"
                  onChange={handleFileSelect}
                  className="hidden"
                  disabled={uploadMutation.isPending}
                  data-testid="input-file-upload"
                />
                <Button
                  variant="outline"
                  disabled={uploadMutation.isPending}
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
      />

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
