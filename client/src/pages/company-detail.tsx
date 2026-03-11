import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  ArrowLeft,
  Building2,
  Users,
  Plus,
  Pencil,
  Trash2,
  ExternalLink,
  Network,
  List,
  Trophy,
  TruckIcon,
  AlertTriangle,
  BarChart3,
  UserPlus,
  CheckCircle,
  Clock,
  Download,
  MapPin,
  ShieldCheck,
  ShieldAlert,
  Route,
  ArrowRightLeft,
  Warehouse,
  ArrowDownToLine,
  ArrowUpFromLine,
  Repeat2,
  ArrowUpDown,
  ChevronsUpDown,
} from "lucide-react";
import * as XLSX from "xlsx";
import { CompanyDialog } from "@/components/company-dialog";
import { ContactDialog } from "@/components/contact-dialog";
import { ResearchLaneDialog } from "@/components/research-lane-dialog";
import { OrgChart } from "@/components/org-chart";
import { ContactList } from "@/components/contact-list";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Company, Contact } from "@shared/schema";

interface ResearchTask {
  rfpId: string;
  rfpTitle: string;
  companyId: string;
  laneIndex: number;
  lane: string;
  laneId?: string;
  origin: string;
  destination: string;
  originState: string;
  destinationState: string;
  volume: number;
  rate: string;
  equipment?: string;
  status: string;
  contactId: string | null;
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
  coveredBy: string | null;
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

export default function CompanyDetail() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const searchString = useSearch();
  const { toast } = useToast();
  const companyId = params.id!;

  const [editCompanyOpen, setEditCompanyOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | undefined>();
  const [contactDefaults, setContactDefaults] = useState<{ lane?: string; region?: string } | undefined>();
  const [researchDialogOpen, setResearchDialogOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<ResearchTask | null>(null);
  const [laneSort, setLaneSort] = useState<{ col: string; dir: "asc" | "desc" }>({ col: "volume", dir: "desc" });

  useEffect(() => {
    const urlParams = new URLSearchParams(searchString);
    if (urlParams.get("newContact") === "true") {
      const lane = urlParams.get("lane") || undefined;
      const region = urlParams.get("region") || undefined;
      setContactDefaults({ lane, region });
      setEditingContact(undefined);
      setContactDialogOpen(true);
      navigate(`/companies/${companyId}`, { replace: true });
    }
  }, [searchString, companyId, navigate]);

  const { data: company, isLoading: companyLoading } = useQuery<Company>({
    queryKey: ["/api/companies", companyId],
  });

  const { data: contacts, isLoading: contactsLoading } = useQuery<Contact[]>({
    queryKey: ["/api/companies", companyId, "contacts"],
  });

  const { data: researchTasks } = useQuery<ResearchTask[]>({
    queryKey: ["/api/research-tasks", { companyId }],
    queryFn: async () => {
      const res = await fetch(`/api/research-tasks?companyId=${companyId}`);
      if (!res.ok) throw new Error("Failed to fetch research tasks");
      return res.json();
    },
  });

  const { data: facilityCoverage } = useQuery<FacilityCoverage>({
    queryKey: ["/api/companies", companyId, "facility-coverage"],
  });

  const { data: lanePatterns } = useQuery<LanePatterns>({
    queryKey: ["/api/companies", companyId, "lane-patterns"],
  });

  const openTasks = researchTasks?.filter((t) => t.status === "open") || [];

  const markResearchedMutation = useMutation({
    mutationFn: async (task: ResearchTask) => {
      await apiRequest("PATCH", `/api/rfps/${task.rfpId}/lanes/${task.laneIndex}/status`, {
        status: "researched",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/research-tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/rfps"] });
      toast({
        title: "Lane marked as researched",
        className: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800",
      });
    },
  });

  const handleAssignTask = (task: ResearchTask) => {
    setSelectedTask(task);
    setResearchDialogOpen(true);
  };

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/companies/${companyId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      toast({ title: "Company deleted successfully" });
      navigate("/customers");
    },
    onError: (error: Error) => {
      toast({ title: "Error deleting company", description: error.message, variant: "destructive" });
    },
  });

  const handleEditContact = (contact: Contact) => {
    setEditingContact(contact);
    setContactDialogOpen(true);
  };

  const handleAddContact = () => {
    setEditingContact(undefined);
    setContactDialogOpen(true);
  };

  const handleExport = () => {
    if (!company || !contacts) return;

    const wb = XLSX.utils.book_new();

    const highVolumeLanesData = (researchTasks || []).map((task) => {
      const linkedContact = task.contactId && contacts
        ? contacts.find((c) => c.id === task.contactId)
        : null;
      return {
        "Lane": task.lane,
        "Origin": task.origin || task.originState || "",
        "Destination": task.destination || task.destinationState || "",
        "Annual Shipments": task.volume,
        "Rate": task.rate || "",
        "Status": task.status === "open" ? "Open" : task.status === "contact_added" ? "Contact Added" : "Researched",
        "Assigned Contact": linkedContact?.name || "",
        "RFP": task.rfpTitle,
      };
    });

    if (highVolumeLanesData.length > 0) {
      const ws1 = XLSX.utils.json_to_sheet(highVolumeLanesData);
      ws1["!cols"] = [
        { wch: 30 }, { wch: 15 }, { wch: 15 }, { wch: 18 },
        { wch: 12 }, { wch: 16 }, { wch: 20 }, { wch: 25 },
      ];
      XLSX.utils.book_append_sheet(wb, ws1, "High-Volume Lanes");
    }

    const contactsData = contacts.map((c) => ({
      "Name": c.name,
      "Title": c.title || "",
      "Email": c.email || "",
      "Phone": c.phone || "",
      "Lanes": c.lanes?.join(", ") || "",
      "Regions": c.regions?.join(", ") || "",
      "Freight Spend": c.freightSpend ? `$${Number(c.freightSpend).toLocaleString()}` : "",
      "Spot Bidding Process": c.spotBiddingProcess || "",
      "Relationship Base": c.relationshipBase || "",
      "Notes": c.notes || "",
    }));

    const ws2 = XLSX.utils.json_to_sheet(contactsData.length > 0 ? contactsData : [{ "Name": "No contacts yet" }]);
    ws2["!cols"] = [
      { wch: 20 }, { wch: 25 }, { wch: 25 }, { wch: 16 },
      { wch: 25 }, { wch: 20 }, { wch: 18 }, { wch: 30 },
      { wch: 16 }, { wch: 30 },
    ];
    XLSX.utils.book_append_sheet(wb, ws2, "All Contacts");

    const contactMap = new Map(contacts.map((c) => [c.id, c]));
    const orgChartData = contacts.map((c) => {
      const reportsTo = c.reportsToId ? contactMap.get(c.reportsToId) : null;
      return {
        "Name": c.name,
        "Title": c.title || "",
        "Reports To": reportsTo?.name || "",
        "Email": c.email || "",
        "Phone": c.phone || "",
        "Lanes": c.lanes?.join(", ") || "",
        "Regions": c.regions?.join(", ") || "",
        "Freight Spend": c.freightSpend ? `$${Number(c.freightSpend).toLocaleString()}` : "",
      };
    });

    const ws3 = XLSX.utils.json_to_sheet(orgChartData.length > 0 ? orgChartData : [{ "Name": "No contacts yet" }]);
    ws3["!cols"] = [
      { wch: 20 }, { wch: 25 }, { wch: 20 }, { wch: 25 },
      { wch: 16 }, { wch: 25 }, { wch: 20 }, { wch: 18 },
    ];
    XLSX.utils.book_append_sheet(wb, ws3, "Org Chart");

    const fileName = `${company.name.replace(/[^a-zA-Z0-9]/g, "_")}_Org_Chart.xlsx`;
    XLSX.writeFile(wb, fileName);

    toast({ title: "Export complete", description: `Saved as ${fileName}` });
  };

  const isLoading = companyLoading || contactsLoading;

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 p-4 sm:p-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 w-10 rounded-lg" />
          <div>
            <Skeleton className="h-6 w-48 mb-2" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!company) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-12">
        <Building2 className="h-12 w-12 text-muted-foreground/50" />
        <h2 className="text-lg font-medium">Company not found</h2>
        <Button variant="outline" onClick={() => navigate("/customers")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Customers
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 sm:gap-6 p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/customers")}
            data-testid="button-back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Building2 className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold" data-testid="text-company-name">
                {company.name}
              </h1>
              <div className="flex items-center gap-2 text-muted-foreground">
                {company.industry && (
                  <Badge variant="secondary">{company.industry}</Badge>
                )}
                {company.website && (
                  <a
                    href={company.website.startsWith("http") ? company.website : `https://${company.website}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-sm hover:text-foreground"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Website
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" onClick={handleExport} data-testid="button-export">
            <Download className="h-4 w-4 mr-2" />
            Export Org Chart + Contacts
          </Button>
          <Button variant="outline" onClick={() => navigate("/rfp-awards")} data-testid="button-rfp-awards">
            <Trophy className="h-4 w-4 mr-2" />
            RFP & Awards
          </Button>
          <Button variant="outline" onClick={() => setEditCompanyOpen(true)} data-testid="button-edit-company">
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </Button>
          <Button variant="outline" onClick={() => setDeleteDialogOpen(true)} data-testid="button-delete-company">
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </Button>
        </div>
      </div>

      {company.notes && (
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{company.notes}</p>
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-org-chart-section">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Network className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              <h2 className="text-base font-medium">Org Chart</h2>
              <Badge variant="secondary">{contacts?.length || 0} contacts</Badge>
            </div>
            <Button onClick={handleAddContact} data-testid="button-add-contact-top">
              <Plus className="h-4 w-4 mr-2" />
              Add Contact
            </Button>
          </div>
          {contacts && contacts.length > 0 ? (
            <OrgChart contacts={contacts} onEditContact={handleEditContact} />
          ) : (
            <div className="flex flex-col items-center justify-center py-8">
              <Users className="h-10 w-10 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground text-center max-w-sm">
                Start building your org chart by adding the first contact for this company
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {researchTasks && researchTasks.length > 0 && (() => {
        const unresolvedTasks = researchTasks.filter((t) => t.status === "open" || t.status === "contact_added");
        const completedTasks = researchTasks.filter((t) => t.status === "researched");

        return (
          <Card className="border-2 border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20" data-testid="card-lanes-needing-contacts">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-3">
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
                </div>
              </div>

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

                const sorted = [...unresolvedTasks].sort((a, b) => {
                  const dir = laneSort.dir === "asc" ? 1 : -1;
                  switch (laneSort.col) {
                    case "origin": return dir * fmtLoc(a.origin, a.originState).localeCompare(fmtLoc(b.origin, b.originState));
                    case "destination": return dir * fmtLoc(a.destination, a.destinationState).localeCompare(fmtLoc(b.destination, b.destinationState));
                    case "volume": return dir * (a.volume - b.volume);
                    case "equipment": return dir * (a.equipment || "").localeCompare(b.equipment || "");
                    case "rfp": return dir * a.rfpTitle.localeCompare(b.rfpTitle);
                    case "status": return dir * a.status.localeCompare(b.status);
                    default: return 0;
                  }
                });

                if (unresolvedTasks.length === 0) {
                  return (
                    <p className="text-sm text-muted-foreground">
                      All high-volume lanes have been researched.
                    </p>
                  );
                }

                const thClass = "text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide py-2 px-3 cursor-pointer select-none hover:text-foreground transition-colors whitespace-nowrap";

                return (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 border-b">
                        <tr>
                          <th className={thClass} onClick={() => handleLaneSort("origin")}>
                            Origin <SortIcon col="origin" />
                          </th>
                          <th className={thClass} onClick={() => handleLaneSort("destination")}>
                            Destination <SortIcon col="destination" />
                          </th>
                          <th className={thClass} onClick={() => handleLaneSort("volume")}>
                            Volume <SortIcon col="volume" />
                          </th>
                          <th className={thClass} onClick={() => handleLaneSort("equipment")}>
                            Equipment <SortIcon col="equipment" />
                          </th>
                          <th className={thClass} onClick={() => handleLaneSort("rfp")}>
                            RFP <SortIcon col="rfp" />
                          </th>
                          <th className={thClass} onClick={() => handleLaneSort("status")}>
                            Status <SortIcon col="status" />
                          </th>
                          <th className="text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide py-2 px-3 whitespace-nowrap">
                            Action
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((task, i) => {
                          const linkedContact = task.contactId && contacts
                            ? contacts.find((c) => c.id === task.contactId)
                            : null;
                          return (
                            <tr
                              key={`${task.rfpId}-${task.laneIndex}`}
                              className="border-b last:border-0 hover:bg-muted/40 transition-colors"
                              data-testid={`lane-task-${i}`}
                            >
                              <td className="py-2 px-3 font-medium">
                                {fmtLoc(task.origin, task.originState)}
                              </td>
                              <td className="py-2 px-3 font-medium">
                                {fmtLoc(task.destination, task.destinationState)}
                              </td>
                              <td className="py-2 px-3 text-muted-foreground whitespace-nowrap">
                                {Math.round(task.volume).toLocaleString()} / yr
                              </td>
                              <td className="py-2 px-3 text-muted-foreground">
                                {task.equipment || "—"}
                              </td>
                              <td className="py-2 px-3 text-muted-foreground max-w-[180px] truncate" title={task.rfpTitle}>
                                {task.rfpTitle}
                              </td>
                              <td className="py-2 px-3">
                                {task.status === "open" ? (
                                  <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                                    <Clock className="h-3 w-3 mr-1" />
                                    Open
                                  </Badge>
                                ) : (
                                  <Badge className="bg-blue-500/10 text-blue-600 dark:text-blue-400">
                                    <UserPlus className="h-3 w-3 mr-1" />
                                    Contact Added
                                  </Badge>
                                )}
                                {linkedContact && (
                                  <span className="ml-2 text-xs text-green-600 dark:text-green-400">
                                    {linkedContact.name}
                                  </span>
                                )}
                              </td>
                              <td className="py-2 px-3 whitespace-nowrap">
                                {task.status === "open" ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-400"
                                    onClick={() => handleAssignTask(task)}
                                    data-testid={`button-assign-lane-task-${i}`}
                                  >
                                    <UserPlus className="h-4 w-4 mr-1" />
                                    Assign
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
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </CardContent>
          </Card>
        );
      })()}

      {facilityCoverage && facilityCoverage.facilities.length > 0 && (
        <Card data-testid="card-facility-coverage">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <MapPin className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                <h2 className="text-base font-medium">
                  Facility Coverage
                </h2>
              </div>
              <div className="flex items-center gap-2">
                {facilityCoverage.summary.gaps > 0 && (
                  <Badge className="bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400" data-testid="badge-coverage-gaps">
                    <ShieldAlert className="h-3 w-3 mr-1" />
                    {facilityCoverage.summary.gaps} gap{facilityCoverage.summary.gaps !== 1 ? "s" : ""}
                  </Badge>
                )}
                {facilityCoverage.summary.covered > 0 && (
                  <Badge className="bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400" data-testid="badge-coverage-covered">
                    <ShieldCheck className="h-3 w-3 mr-1" />
                    {facilityCoverage.summary.covered} covered
                  </Badge>
                )}
              </div>
            </div>

            <div className="space-y-2">
              {facilityCoverage.facilities.map((f, i) => (
                <div
                  key={`${f.fullName}-${f.type}-${i}`}
                  className={`flex items-center justify-between p-3 rounded-md border transition-colors ${
                    f.covered
                      ? "bg-green-50/50 border-green-200/50 dark:bg-green-950/20 dark:border-green-800/30"
                      : "bg-red-50/50 border-red-200/50 dark:bg-red-950/20 dark:border-red-800/30"
                  }`}
                  data-testid={`facility-${i}`}
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
                        {f.covered && f.coveredBy && (
                          <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
                            <Users className="h-3 w-3" />
                            {f.coveredBy}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex-shrink-0">
                    {f.covered ? (
                      <Badge className="bg-green-500/10 text-green-600 dark:text-green-400">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Covered
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-red-300 text-red-700 hover:bg-red-100 dark:border-red-700 dark:text-red-400"
                        onClick={() => {
                          setContactDefaults({
                            lane: f.fullName,
                            region: f.state || undefined,
                          });
                          setEditingContact(undefined);
                          setContactDialogOpen(true);
                        }}
                        data-testid={`button-find-planner-${i}`}
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
        </Card>
      )}

      {lanePatterns && (lanePatterns.topCorridors.length > 0 || lanePatterns.hubs.length > 0 || lanePatterns.stateCorridors.length > 0) && (
        <Card data-testid="card-lane-patterns">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Route className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              <h2 className="text-base font-medium">Lane Patterns</h2>
            </div>

            <Tabs defaultValue="corridors" className="w-full">
              <TabsList className="w-full grid grid-cols-3">
                <TabsTrigger value="corridors" data-testid="tab-top-corridors">
                  <ArrowRightLeft className="h-3.5 w-3.5 mr-1.5" />
                  Top Corridors
                </TabsTrigger>
                <TabsTrigger value="hubs" data-testid="tab-hubs">
                  <Warehouse className="h-3.5 w-3.5 mr-1.5" />
                  Shipping/Receiving Hubs
                </TabsTrigger>
                <TabsTrigger value="states" data-testid="tab-state-corridors">
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
                        data-testid={`corridor-${i}`}
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
                        data-testid={`hub-${i}`}
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
                            <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors" data-testid={`state-corridor-${i}`}>
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
        </Card>
      )}

      {contacts && contacts.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <List className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-medium">Contact Details</h2>
          </div>
          <ContactList
            contacts={contacts}
            companyId={companyId}
            onEditContact={handleEditContact}
          />
        </div>
      )}

      <CompanyDialog
        open={editCompanyOpen}
        onOpenChange={setEditCompanyOpen}
        company={company}
      />

      <ContactDialog
        open={contactDialogOpen}
        onOpenChange={(open) => {
          setContactDialogOpen(open);
          if (!open) {
            setEditingContact(undefined);
            setContactDefaults(undefined);
          }
        }}
        companyId={companyId}
        contact={editingContact}
        defaults={contactDefaults}
      />

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Company</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {company.name}? This will also delete all contacts
              associated with this company. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
    </div>
  );
}
