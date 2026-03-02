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
  origin: string;
  destination: string;
  originState: string;
  destinationState: string;
  volume: number;
  rate: string;
  status: string;
  contactId: string | null;
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

              {unresolvedTasks.length > 0 ? (
                <div className="space-y-2">
                  {unresolvedTasks.map((task, i) => {
                    const linkedContact = task.contactId && contacts
                      ? contacts.find((c) => c.id === task.contactId)
                      : null;
                    return (
                      <div
                        key={`${task.rfpId}-${task.laneIndex}`}
                        className="flex items-center justify-between p-3 rounded-md border bg-background hover:bg-muted/50 transition-colors"
                        data-testid={`lane-task-${i}`}
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <TruckIcon className="h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                          <div className="min-w-0">
                            <p className="font-medium text-sm truncate">{task.lane}</p>
                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                              {task.laneId && (
                                <span className="font-mono text-muted-foreground/70">{task.laneId}</span>
                              )}
                              <span className="flex items-center gap-1">
                                <BarChart3 className="h-3 w-3" />
                                {task.volume.toLocaleString()} / yr
                              </span>
                              <span>{task.rfpTitle}</span>
                              {linkedContact && (
                                <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
                                  <Users className="h-3 w-3" />
                                  {linkedContact.name}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {task.status === "open" ? (
                            <>
                              <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                                <Clock className="h-3 w-3 mr-1" />
                                Open
                              </Badge>
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-400"
                                onClick={() => handleAssignTask(task)}
                                data-testid={`button-assign-lane-task-${i}`}
                              >
                                <UserPlus className="h-4 w-4 mr-1" />
                                Assign Lane to Planner
                              </Button>
                            </>
                          ) : (
                            <>
                              <Badge className="bg-blue-500/10 text-blue-600 dark:text-blue-400">
                                <UserPlus className="h-3 w-3 mr-1" />
                                Contact Added
                              </Badge>
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
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  All high-volume lanes have been researched.
                </p>
              )}
            </CardContent>
          </Card>
        );
      })()}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-medium">Contacts</h2>
          <Badge variant="secondary">{contacts?.length || 0}</Badge>
        </div>
        <Button onClick={handleAddContact} data-testid="button-add-contact">
          <Plus className="h-4 w-4 mr-2" />
          Add Contact
        </Button>
      </div>

      {contacts && contacts.length > 0 ? (
        <Tabs defaultValue="org-chart" className="w-full">
          <TabsList>
            <TabsTrigger value="org-chart" data-testid="tab-org-chart">
              <Network className="h-4 w-4 mr-2" />
              Org Chart
            </TabsTrigger>
            <TabsTrigger value="list" data-testid="tab-list">
              <List className="h-4 w-4 mr-2" />
              List View
            </TabsTrigger>
          </TabsList>
          <TabsContent value="org-chart" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Organization Chart</CardTitle>
              </CardHeader>
              <CardContent>
                <OrgChart contacts={contacts} onEditContact={handleEditContact} />
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="list" className="mt-4">
            <ContactList
              contacts={contacts}
              companyId={companyId}
              onEditContact={handleEditContact}
            />
          </TabsContent>
        </Tabs>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Users className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-medium mb-1">No contacts yet</h3>
            <p className="text-sm text-muted-foreground text-center max-w-sm mb-4">
              Start building your org chart by adding the first contact for this company
            </p>
            <Button onClick={handleAddContact} data-testid="button-add-first-contact">
              <Plus className="h-4 w-4 mr-2" />
              Add First Contact
            </Button>
          </CardContent>
        </Card>
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
