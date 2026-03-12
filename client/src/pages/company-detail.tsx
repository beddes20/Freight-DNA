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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Globe,
  KeyRound,
  Eye,
  EyeOff,
  UserCheck,
  Zap,
  TrendingUp,
  ChevronDown,
  ClipboardList,
  Circle,
  PlayCircle,
  CheckCircle2,
  Calendar,
  Megaphone,
  MessageSquare,
} from "lucide-react";
import * as XLSX from "xlsx";
import { CompanyDialog } from "@/components/company-dialog";
import { ContactDialog } from "@/components/contact-dialog";
import { ResearchLaneDialog } from "@/components/research-lane-dialog";
import { OrgChart } from "@/components/org-chart";
import { ContactList } from "@/components/contact-list";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { TaskDialog } from "@/components/task-dialog";
import { CalloutDialog } from "@/components/callout-dialog";
import type { Company, Contact, User, Task, Callout, CalloutReaction } from "@shared/schema";

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

interface LaneMatch {
  rfpTitle: string;
  rfpId: string;
  customerCity: string;
  customerState: string;
  customerLane: string;
  customerVolume: number;
  ourCity: string;
  ourState: string;
  distance: number;
  weeklyLoads: number;
  totalLoads: number;
}

interface LaneMatching {
  ourDeliveriesToTheirPickups: LaneMatch[];
  theirDeliveriesToOurPickups: LaneMatch[];
  hasHistoricalData: boolean;
  hasRfpData: boolean;
}

export default function CompanyDetail() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const searchString = useSearch();
  const { toast } = useToast();
  const { user: currentUser } = useAuth();
  const companyId = params.id!;

  const [editCompanyOpen, setEditCompanyOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | undefined>();
  const [contactDefaults, setContactDefaults] = useState<{ lane?: string; region?: string } | undefined>();
  const [researchDialogOpen, setResearchDialogOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<ResearchTask | null>(null);
  const [laneSort, setLaneSort] = useState<{ col: string; dir: "asc" | "desc" }>({ col: "origin", dir: "asc" });
  const [findPlannerFacility, setFindPlannerFacility] = useState<Facility | null>(null);
  const [assignExistingContactId, setAssignExistingContactId] = useState<string>("");
  const [portalEdit, setPortalEdit] = useState(false);
  const [portalUrl, setPortalUrl] = useState("");
  const [portalUsername, setPortalUsername] = useState("");
  const [portalPassword, setPortalPassword] = useState("");
  const [showPortalPassword, setShowPortalPassword] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTo, setTransferTo] = useState("");
  const [laneMatchMode, setLaneMatchMode] = useState<"deliveries" | "pickups">("deliveries");
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [editingTaskItem, setEditingTaskItem] = useState<Task | undefined>();
  const [forceLanePrefill, setForceLanePrefill] = useState<{ title: string; notes?: string; attachedLaneData?: any[] } | undefined>();
  const [lanesCollapsed, setLanesCollapsed] = useState(false);
  const [facilityCoverageCollapsed, setFacilityCoverageCollapsed] = useState(false);
  const [lanePatternsCollapsed, setLanePatternsCollapsed] = useState(false);
  const [laneMatchingCollapsed, setLaneMatchingCollapsed] = useState(false);
  const [calloutDialogOpen, setCalloutDialogOpen] = useState(false);
  const [calloutReplyTo, setCalloutReplyTo] = useState<{ id: string; title: string } | undefined>();
  const [expandedCallouts, setExpandedCallouts] = useState<Set<string>>(new Set());

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

  const { data: laneMatching } = useQuery<LaneMatching>({
    queryKey: ["/api/companies", companyId, "lane-matching"],
  });

  const { data: companyTasks = [] } = useQuery<Task[]>({
    queryKey: ["/api/tasks/company", companyId],
  });

  const { data: teamMembers = [] } = useQuery<Omit<User, "password">[]>({
    queryKey: ["/api/team-members"],
  });

  const { data: companyCallouts = [] } = useQuery<Callout[]>({
    queryKey: ["/api/callouts/company", companyId],
  });

  const deleteCalloutMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/callouts/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/callouts/company", companyId] });
      queryClient.invalidateQueries({ queryKey: ["/api/callouts"] });
      toast({ title: "Callout deleted" });
    },
  });

  const topLevelCompanyCallouts = companyCallouts
    .filter(c => !c.parentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const companyCalloutRepliesFor = (parentId: string) =>
    companyCallouts
      .filter(c => c.parentId === parentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const toggleCalloutExpanded = (id: string) => {
    setExpandedCallouts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const getCalloutAuthorName = (authorId: string) => teamMembers.find(u => u.id === authorId)?.name || "Unknown";

  const calloutTagColors: Record<string, string> = {
    Trend: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
    Callout: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
    Idea: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400",
  };

  const formatCalloutTime = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  const REACTION_EMOJIS = ["👍", "❤️", "🔥", "💡", "✅"];
  const canReact = currentUser?.role === "admin" || currentUser?.role === "director";

  const calloutIds = topLevelCompanyCallouts.map(c => c.id);
  const { data: calloutReactions = [] } = useQuery<CalloutReaction[]>({
    queryKey: ["/api/callouts/reactions", calloutIds.join(",")],
    queryFn: async () => {
      if (calloutIds.length === 0) return [];
      const res = await fetch(`/api/callouts/reactions?ids=${calloutIds.join(",")}`);
      if (!res.ok) throw new Error("Failed to fetch reactions");
      return res.json();
    },
    enabled: calloutIds.length > 0,
  });

  const toggleReactionMutation = useMutation({
    mutationFn: async ({ calloutId, emoji }: { calloutId: string; emoji: string }) => {
      await apiRequest("POST", `/api/callouts/${calloutId}/reactions`, { emoji });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/callouts/reactions"] });
    },
  });

  const toggleTaskStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      await apiRequest("PATCH", `/api/tasks/${id}`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/company", companyId] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
    },
  });

  const deleteTaskMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/tasks/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/company", companyId] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      toast({ title: "Task deleted" });
    },
  });

  const canReassign = currentUser?.role === "admin" || currentUser?.role === "director" || currentUser?.role === "national_account_manager" || currentUser?.role === "sales";
  const { data: assignableUsers = [] } = useQuery<Omit<User, "password">[]>({
    queryKey: ["/api/users"],
    enabled: canReassign,
  });

  const savePortalMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/companies/${companyId}`, {
        name: company!.name,
        portalUrl: portalUrl || null,
        portalUsername: portalUsername || null,
        portalPassword: portalPassword || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId] });
      setPortalEdit(false);
      toast({ title: "Portal info saved", className: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800" });
    },
    onError: () => toast({ title: "Failed to save portal info", variant: "destructive" }),
  });

  const reassignMutation = useMutation({
    mutationFn: async (assignedTo: string) => {
      await apiRequest("PATCH", `/api/companies/${companyId}/reassign`, { assignedTo });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      setTransferOpen(false);
      setTransferTo("");
      toast({ title: "Account transferred successfully", className: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800" });
    },
    onError: (e: any) => toast({ title: "Failed to transfer account", description: e.message, variant: "destructive" }),
  });

  const openPortalEdit = () => {
    setPortalUrl(company?.portalUrl || "");
    setPortalUsername(company?.portalUsername || "");
    setPortalPassword(company?.portalPassword || "");
    setPortalEdit(true);
  };

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

  const assignContactToFacilityMutation = useMutation({
    mutationFn: async ({ contactId, laneToAdd }: { contactId: string; laneToAdd: string }) => {
      const contact = contacts?.find((c) => c.id === contactId);
      if (!contact) throw new Error("Contact not found");
      const existingLanes: string[] = contact.lanes || [];
      if (!existingLanes.includes(laneToAdd)) {
        await apiRequest("PATCH", `/api/contacts/${contactId}`, {
          lanes: [...existingLanes, laneToAdd],
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "facility-coverage"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "contacts"] });
      setFindPlannerFacility(null);
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

  const openForceTask = (title: string, notes: string) => {
    setForceLanePrefill({ title, notes });
    setEditingTaskItem(undefined);
    setTaskDialogOpen(true);
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
          {canReassign && (
            <Button variant="outline" onClick={() => { setTransferTo(company.assignedTo || ""); setTransferOpen(true); }} data-testid="button-transfer-account">
              <UserCheck className="h-4 w-4 mr-2" />
              Transfer Account
            </Button>
          )}
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

      {/* Customer Portal Information */}
      <Card data-testid="card-portal-info">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Globe className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              Customer Portal Information
            </CardTitle>
            {!portalEdit && (
              <Button variant="ghost" size="sm" onClick={openPortalEdit} data-testid="button-edit-portal">
                <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {portalEdit ? (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Globe className="h-3 w-3" /> Portal URL</label>
                <input
                  className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder="https://portal.example.com"
                  value={portalUrl}
                  onChange={e => setPortalUrl(e.target.value)}
                  data-testid="input-portal-url"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Users className="h-3 w-3" /> Username</label>
                <input
                  className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder="username"
                  value={portalUsername}
                  onChange={e => setPortalUsername(e.target.value)}
                  data-testid="input-portal-username"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><KeyRound className="h-3 w-3" /> Password</label>
                <div className="relative">
                  <input
                    className="w-full border rounded-md px-3 py-1.5 pr-9 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                    type={showPortalPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={portalPassword}
                    onChange={e => setPortalPassword(e.target.value)}
                    data-testid="input-portal-password"
                  />
                  <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setShowPortalPassword(v => !v)} data-testid="button-toggle-password">
                    {showPortalPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={() => savePortalMutation.mutate()} disabled={savePortalMutation.isPending} data-testid="button-save-portal">
                  {savePortalMutation.isPending && <span className="mr-1 h-3 w-3 animate-spin rounded-full border-2 border-background border-t-transparent inline-block" />}
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPortalEdit(false)} data-testid="button-cancel-portal">Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><Globe className="h-3 w-3" /> Portal URL</p>
                {company.portalUrl ? (
                  <a href={company.portalUrl.startsWith("http") ? company.portalUrl : `https://${company.portalUrl}`} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1" data-testid="link-portal-url">
                    {company.portalUrl} <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <p className="text-sm text-muted-foreground italic">Not set</p>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><Users className="h-3 w-3" /> Username</p>
                <p className="text-sm font-mono" data-testid="text-portal-username">{company.portalUsername || <span className="text-muted-foreground italic font-sans">Not set</span>}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><KeyRound className="h-3 w-3" /> Password</p>
                {company.portalPassword ? (
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-mono" data-testid="text-portal-password">{showPortalPassword ? company.portalPassword : "••••••••"}</p>
                    <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setShowPortalPassword(v => !v)} data-testid="button-reveal-password">
                      {showPortalPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic">Not set</p>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Account Tasks */}
      <Card data-testid="card-company-tasks">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              Tasks
              {companyTasks.filter(t => t.status !== "completed").length > 0 && (
                <Badge variant="secondary" className="ml-1 font-normal">{companyTasks.filter(t => t.status !== "completed").length}</Badge>
              )}
            </CardTitle>
            <Button size="sm" variant="outline" className="gap-1" onClick={() => { setEditingTaskItem(undefined); setForceLanePrefill(undefined); setTaskDialogOpen(true); }} data-testid="button-add-company-task">
              <Plus className="h-3 w-3" /> Add Task
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {companyTasks.length > 0 ? (
            <div className="space-y-1">
              {companyTasks
                .sort((a, b) => {
                  if (a.status === "completed" && b.status !== "completed") return 1;
                  if (a.status !== "completed" && b.status === "completed") return -1;
                  if (!a.dueDate && !b.dueDate) return 0;
                  if (!a.dueDate) return 1;
                  if (!b.dueDate) return -1;
                  return a.dueDate.localeCompare(b.dueDate);
                })
                .map(task => {
                  const assigneeName = teamMembers.find(u => u.id === task.assignedTo)?.name || "";
                  const ns = task.status === "open" ? "in_progress" : task.status === "in_progress" ? "completed" : "open";
                  const dueBadge = (() => {
                    if (!task.dueDate) return null;
                    const today = new Date(); today.setHours(0,0,0,0);
                    const due = new Date(task.dueDate + "T00:00:00");
                    const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
                    let color = "bg-muted text-muted-foreground";
                    if (diff < 0) color = "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
                    else if (diff === 0) color = "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
                    const label = diff < 0 ? `${Math.abs(diff)}d overdue` : diff === 0 ? "Today" : `${diff}d`;
                    return <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md font-medium ${color}`}><Calendar className="h-3 w-3" />{label}</span>;
                  })();
                  return (
                    <div key={task.id} className={`flex items-center gap-3 p-3 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all group ${task.status === "completed" ? "opacity-50" : ""}`} data-testid={`company-task-row-${task.id}`}>
                      <button onClick={() => toggleTaskStatus.mutate({ id: task.id, status: ns })} className="shrink-0 hover:scale-110 transition-transform" title={`Status: ${task.status}`} data-testid={`button-toggle-company-task-${task.id}`}>
                        {task.status === "completed" ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : task.status === "in_progress" ? <PlayCircle className="h-4 w-4 text-blue-500" /> : <Circle className="h-4 w-4 text-muted-foreground" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${task.status === "completed" ? "line-through text-muted-foreground" : ""}`}>{task.title}</p>
                        {assigneeName && <p className="text-xs text-muted-foreground">{assigneeName}</p>}
                      </div>
                      {dueBadge}
                      <button onClick={() => { setEditingTaskItem(task); setForceLanePrefill(undefined); setTaskDialogOpen(true); }} className="shrink-0 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity text-xs" data-testid={`button-edit-company-task-${task.id}`}>Edit</button>
                      <button onClick={() => deleteTaskMutation.mutate(task.id)} className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" data-testid={`button-delete-company-task-${task.id}`}><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  );
                })}
            </div>
          ) : (
            <div className="text-center py-4 text-muted-foreground">
              <ClipboardList className="h-6 w-6 mx-auto mb-1 opacity-50" />
              <p className="text-xs">No tasks yet — add one to track follow-ups for this account</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Account Callouts */}
      <Card data-testid="card-company-callouts">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Megaphone className="h-4 w-4 text-orange-600 dark:text-orange-400" />
              Callouts
              {topLevelCompanyCallouts.length > 0 && (
                <Badge variant="secondary" className="ml-1 font-normal">{topLevelCompanyCallouts.length}</Badge>
              )}
            </CardTitle>
            <Button size="sm" variant="outline" className="gap-1" onClick={() => { setCalloutReplyTo(undefined); setCalloutDialogOpen(true); }} data-testid="button-add-company-callout">
              <Plus className="h-3 w-3" /> Add Callout
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {topLevelCompanyCallouts.length > 0 ? (
            <div className="space-y-1">
              {topLevelCompanyCallouts.map(callout => {
                const replies = companyCalloutRepliesFor(callout.id);
                const isExpanded = expandedCallouts.has(callout.id);
                return (
                  <div key={callout.id} data-testid={`company-callout-row-${callout.id}`}>
                    <div className="flex items-start gap-3 p-3 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all group">
                      <Megaphone className="h-4 w-4 mt-0.5 text-orange-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium">{callout.title}</p>
                          {callout.tag && (
                            <span className={`text-xs px-1.5 py-0.5 rounded-md font-medium ${calloutTagColors[callout.tag] || "bg-muted text-muted-foreground"}`}>
                              {callout.tag}
                            </span>
                          )}
                        </div>
                        {callout.body && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{callout.body}</p>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-xs text-muted-foreground">{getCalloutAuthorName(callout.authorId)}</span>
                          <span className="text-xs text-muted-foreground/50">·</span>
                          <span className="text-xs text-muted-foreground">{formatCalloutTime(callout.createdAt)}</span>
                        </div>
                        {(() => {
                          const thisReactions = calloutReactions.filter(r => r.calloutId === callout.id);
                          const emojiCounts = REACTION_EMOJIS.map(emoji => ({
                            emoji,
                            count: thisReactions.filter(r => r.emoji === emoji).length,
                            reacted: thisReactions.some(r => r.emoji === emoji && r.userId === currentUser?.id),
                          }));
                          const hasAny = emojiCounts.some(e => e.count > 0);
                          if (!canReact && !hasAny) return null;
                          return (
                            <div className="flex items-center gap-1 mt-2 flex-wrap" data-testid={`reactions-bar-${callout.id}`}>
                              {emojiCounts.map(({ emoji, count, reacted }) => {
                                if (!canReact && count === 0) return null;
                                return (
                                  <button
                                    key={emoji}
                                    onClick={canReact ? () => toggleReactionMutation.mutate({ calloutId: callout.id, emoji }) : undefined}
                                    disabled={!canReact || toggleReactionMutation.isPending}
                                    className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full border transition-all ${
                                      reacted
                                        ? "bg-primary/10 border-primary/30 text-primary"
                                        : count > 0
                                          ? "bg-muted/50 border-border text-muted-foreground"
                                          : "bg-transparent border-transparent text-muted-foreground/50 hover:bg-muted/50 hover:border-border"
                                    } ${canReact ? "cursor-pointer hover:scale-105" : "cursor-default"}`}
                                    data-testid={`button-reaction-${emoji}-${callout.id}`}
                                  >
                                    <span>{emoji}</span>
                                    {count > 0 && <span className="font-medium">{count}</span>}
                                  </button>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {replies.length > 0 && (
                          <button
                            onClick={() => toggleCalloutExpanded(callout.id)}
                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-1"
                            data-testid={`button-toggle-company-callout-replies-${callout.id}`}
                          >
                            <MessageSquare className="h-3 w-3" />
                            {replies.length}
                            <ChevronDown className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                          </button>
                        )}
                        <button
                          onClick={() => { setCalloutReplyTo({ id: callout.id, title: callout.title }); setCalloutDialogOpen(true); }}
                          className="shrink-0 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity text-xs px-1"
                          data-testid={`button-reply-company-callout-${callout.id}`}
                        >
                          Reply
                        </button>
                        {(callout.authorId === currentUser?.id || currentUser?.role === "admin") && (
                          <button
                            onClick={() => deleteCalloutMutation.mutate(callout.id)}
                            className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                            data-testid={`button-delete-company-callout-${callout.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                    {isExpanded && replies.length > 0 && (
                      <div className="ml-7 pl-3 border-l-2 border-muted space-y-1 mb-2">
                        {replies.map(reply => (
                          <div key={reply.id} className="flex items-start gap-2 p-2 rounded-md hover:bg-muted/30 transition-all group/reply" data-testid={`company-callout-reply-${reply.id}`}>
                            <MessageSquare className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium">{reply.title}</p>
                              {reply.body && <p className="text-xs text-muted-foreground mt-0.5">{reply.body}</p>}
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-xs text-muted-foreground">{getCalloutAuthorName(reply.authorId)}</span>
                                <span className="text-xs text-muted-foreground/50">·</span>
                                <span className="text-xs text-muted-foreground">{formatCalloutTime(reply.createdAt)}</span>
                              </div>
                            </div>
                            {(reply.authorId === currentUser?.id || currentUser?.role === "admin") && (
                              <button
                                onClick={() => deleteCalloutMutation.mutate(reply.id)}
                                className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover/reply:opacity-100 transition-opacity"
                                data-testid={`button-delete-company-callout-reply-${reply.id}`}
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-4 text-muted-foreground">
              <Megaphone className="h-6 w-6 mx-auto mb-1 opacity-50" />
              <p className="text-xs">No callouts yet — add one to share trends or ideas about this account</p>
            </div>
          )}
        </CardContent>
      </Card>

      <TaskDialog
        open={taskDialogOpen}
        onOpenChange={(open) => {
          setTaskDialogOpen(open);
          if (!open) setForceLanePrefill(undefined);
        }}
        companyId={companyId}
        editingTask={editingTaskItem}
        prefillData={forceLanePrefill}
      />

      <CalloutDialog
        open={calloutDialogOpen}
        onOpenChange={setCalloutDialogOpen}
        companyId={companyId}
        parentId={calloutReplyTo?.id}
        parentTitle={calloutReplyTo?.title}
      />

      {/* Transfer Account Dialog */}
      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserCheck className="h-5 w-5 text-blue-600" />
              Transfer Account
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">Select who should own <span className="font-medium text-foreground">{company.name}</span>:</p>
            <Select value={transferTo} onValueChange={setTransferTo}>
              <SelectTrigger data-testid="select-transfer-to">
                <SelectValue placeholder="Select a user..." />
              </SelectTrigger>
              <SelectContent>
                {assignableUsers.map(u => (
                  <SelectItem key={u.id} value={u.id} data-testid={`option-transfer-${u.id}`}>
                    {u.name} ({u.role === "admin" ? "Admin" : u.role === "director" ? "Director" : u.role === "national_account_manager" ? "NAM" : u.role === "sales" ? "Sales" : "AM"})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTransferOpen(false)}>Cancel</Button>
            <Button
              onClick={() => transferTo && reassignMutation.mutate(transferTo)}
              disabled={!transferTo || reassignMutation.isPending}
              data-testid="button-confirm-transfer"
            >
              {reassignMutation.isPending && <span className="mr-2 h-3 w-3 animate-spin rounded-full border-2 border-background border-t-transparent inline-block" />}
              Transfer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                                <div className="flex items-center gap-2">
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
                                      <Zap className="h-4 w-4 mr-1" />
                                      Force Task
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
                );
              })()}
            </CardContent>
          </Card>
        );
      })()}

      {facilityCoverage && facilityCoverage.facilities.length > 0 && (
        <Card data-testid="card-facility-coverage">
          <CardHeader className="pb-3">
            <button
              onClick={() => setFacilityCoverageCollapsed(c => !c)}
              className="w-full flex items-center justify-between group"
              data-testid="btn-toggle-facility-coverage"
            >
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
                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${facilityCoverageCollapsed ? "-rotate-90" : ""}`} />
              </div>
            </button>
          </CardHeader>
          {!facilityCoverageCollapsed && (
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
                  <div className="flex items-center gap-2 flex-shrink-0">
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
                          setAssignExistingContactId("");
                          setFindPlannerFacility(f);
                        }}
                        data-testid={`button-find-planner-${i}`}
                      >
                        <UserPlus className="h-4 w-4 mr-1" />
                        Find Planner
                      </Button>
                    )}
                    {canReassign && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-indigo-300 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:text-indigo-400"
                        onClick={() => {
                          setForceLanePrefill({
                            title: `Cover facility: ${f.fullName}`,
                            notes: `Facility: ${f.fullName}\nType: ${f.type === "origin" ? "Origin" : "Destination"}\nVolume: ${f.totalVolume.toLocaleString()} loads/yr\nLanes: ${f.laneCount} lane${f.laneCount !== 1 ? "s" : ""}\nCoverage: ${f.covered ? `Covered by ${f.coveredBy}` : "Gap — no planner assigned"}`,
                            attachedLaneData: [{
                              type: "action_required",
                              label: "Facility Coverage Gap",
                              items: [{
                                lane: f.fullName,
                                volume: f.totalVolume,
                              }],
                            }],
                          });
                          setEditingTaskItem(undefined);
                          setTaskDialogOpen(true);
                        }}
                        data-testid={`button-force-task-facility-${i}`}
                      >
                        <Zap className="h-4 w-4 mr-1" />
                        Force Task
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
        <Card data-testid="card-lane-patterns">
          <CardHeader className="pb-3">
            <button
              onClick={() => setLanePatternsCollapsed(c => !c)}
              className="w-full flex items-center justify-between group"
              data-testid="btn-toggle-lane-patterns"
            >
              <div className="flex items-center gap-2">
                <Route className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                <h2 className="text-base font-medium">Lane Patterns</h2>
              </div>
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${lanePatternsCollapsed ? "-rotate-90" : ""}`} />
            </button>
          </CardHeader>
          {!lanePatternsCollapsed && (
          <CardContent className="pt-0">
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
                        <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                          <span className="text-right text-xs text-muted-foreground font-mono">{c.rfpTitles.join(", ")}</span>
                          {canReassign && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-indigo-300 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:text-indigo-400"
                              onClick={() => openForceTask(
                                `Corridor: ${c.lane}`,
                                `Lane Pattern — Top Corridor\nLane: ${c.lane}\nVolume: ${c.totalVolume.toLocaleString()} loads/yr\nAppearances: ${c.count}x\nRFPs: ${c.rfpTitles.join(", ")}${c.appearsInMultipleRfps ? "\nAppears in multiple RFPs" : ""}`
                              )}
                              data-testid={`button-force-task-corridor-${i}`}
                            >
                              <Zap className="h-4 w-4 mr-1" />
                              Force Task
                            </Button>
                          )}
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
                          {canReassign && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-indigo-300 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:text-indigo-400"
                              onClick={() => openForceTask(
                                `Hub: ${h.fullName}`,
                                `Lane Pattern — Shipping/Receiving Hub\nFacility: ${h.fullName}\nTotal Volume: ${h.totalVolume.toLocaleString()} loads/yr\nOutbound: ${h.outboundVolume.toLocaleString()} (${h.outboundCount} lanes)\nInbound: ${h.inboundVolume.toLocaleString()} (${h.inboundCount} lanes)`
                              )}
                              data-testid={`button-force-task-hub-${i}`}
                            >
                              <Zap className="h-4 w-4 mr-1" />
                              Force Task
                            </Button>
                          )}
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
                          {canReassign && <th className="text-right font-medium px-3 py-2"></th>}
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
                              {canReassign && (
                                <td className="px-3 py-2 text-right">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="border-indigo-300 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:text-indigo-400"
                                    onClick={() => openForceTask(
                                      `State Corridor: ${s.corridor}`,
                                      `Lane Pattern — State Corridor\nCorridor: ${s.corridor}\nLanes: ${s.laneCount}\nVolume: ${s.totalVolume.toLocaleString()} loads/yr`
                                    )}
                                    data-testid={`button-force-task-state-corridor-${i}`}
                                  >
                                    <Zap className="h-4 w-4 mr-1" />
                                    Force Task
                                  </Button>
                                </td>
                              )}
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

      {/* ── Lane Matching Portlet ─────────────────────────────────────────── */}
      {laneMatching && (laneMatching.hasHistoricalData || laneMatching.hasRfpData) && (
        <Card data-testid="card-lane-matching">
          <CardHeader className="pb-3">
            <button
              onClick={() => setLaneMatchingCollapsed(c => !c)}
              className="w-full flex items-center justify-between group"
              data-testid="btn-toggle-lane-matching"
            >
              <div className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-yellow-500" />
                <h2 className="text-base font-medium">Lane Matching</h2>
                <Badge variant="secondary" className="text-xs">75-mi radius</Badge>
              </div>
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${laneMatchingCollapsed ? "-rotate-90" : ""}`} />
            </button>
          </CardHeader>
          {!laneMatchingCollapsed && (
          <CardContent className="pt-0">
            <div className="flex items-center justify-end mb-4">
              <div className="flex rounded-lg border overflow-hidden text-sm">
                <button
                  onClick={() => setLaneMatchMode("deliveries")}
                  className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors ${laneMatchMode === "deliveries" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                  data-testid="btn-match-deliveries"
                >
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                  Our Deliveries → Their Pickups
                </button>
                <button
                  onClick={() => setLaneMatchMode("pickups")}
                  className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors border-l ${laneMatchMode === "pickups" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                  data-testid="btn-match-pickups"
                >
                  <ArrowUpFromLine className="h-3.5 w-3.5" />
                  Their Deliveries → Our Pickups
                </button>
              </div>
            </div>

            {laneMatchMode === "deliveries" ? (
              <>
                <p className="text-xs text-muted-foreground mb-3">
                  Where we already drop freight near this customer's RFP pickup origins — we have trucks in these areas that could serve their lanes.
                </p>
                {!laneMatching.hasHistoricalData ? (
                  <p className="text-sm text-muted-foreground text-center py-6">Upload historical dispatch data on the Historical Data page to see matches.</p>
                ) : !laneMatching.hasRfpData ? (
                  <p className="text-sm text-muted-foreground text-center py-6">Upload an RFP with lane data for this company to see matches.</p>
                ) : laneMatching.ourDeliveriesToTheirPickups.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">No matches found within 75 miles.</p>
                ) : (
                  <div className="space-y-2">
                    {laneMatching.ourDeliveriesToTheirPickups.slice(0, 20).map((m, i) => (
                      <div key={i} className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 hover:bg-muted/40 transition-colors" data-testid={`match-delivery-${i}`}>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{m.customerLane}</p>
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            <span className="text-xs text-muted-foreground">Customer pickup:</span>
                            <span className="text-xs font-medium">{m.customerCity}, {m.customerState}</span>
                            <ArrowRightLeft className="h-3 w-3 text-muted-foreground" />
                            <span className="text-xs text-muted-foreground">We deliver to:</span>
                            <span className="text-xs font-medium">{m.ourCity}, {m.ourState}</span>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <Badge variant={m.distance < 25 ? "default" : "secondary"} className="text-xs">
                            {m.distance === 0 ? "Exact match" : `${m.distance} mi`}
                          </Badge>
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <TrendingUp className="h-3 w-3" />
                            {m.weeklyLoads}/wk · {m.customerVolume.toLocaleString()} vol
                          </div>
                          <span className="text-xs text-muted-foreground truncate max-w-28">{m.rfpTitle}</span>
                          {canReassign && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-indigo-300 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:text-indigo-400 mt-0.5"
                              onClick={() => openForceTask(
                                `Lane Match: ${m.customerLane}`,
                                `Lane Matching — Our Deliveries → Their Pickups\nCustomer Lane: ${m.customerLane}\nCustomer Pickup: ${m.customerCity}, ${m.customerState}\nWe Deliver To: ${m.ourCity}, ${m.ourState}\nDistance: ${m.distance} mi\nFrequency: ${m.weeklyLoads}/wk\nVolume: ${m.customerVolume.toLocaleString()}\nRFP: ${m.rfpTitle}`
                              )}
                              data-testid={`button-force-task-match-delivery-${i}`}
                            >
                              <Zap className="h-3.5 w-3.5 mr-1" />
                              Force Task
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                    {laneMatching.ourDeliveriesToTheirPickups.length > 20 && (
                      <p className="text-xs text-muted-foreground text-center pt-1">+{laneMatching.ourDeliveriesToTheirPickups.length - 20} more matches</p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground mb-3">
                  Where this customer needs deliveries near our existing freight pickup locations — potential backhaul opportunities for us.
                </p>
                {!laneMatching.hasHistoricalData ? (
                  <p className="text-sm text-muted-foreground text-center py-6">Upload historical dispatch data on the Historical Data page to see matches.</p>
                ) : !laneMatching.hasRfpData ? (
                  <p className="text-sm text-muted-foreground text-center py-6">Upload an RFP with lane data for this company to see matches.</p>
                ) : laneMatching.theirDeliveriesToOurPickups.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">No matches found within 75 miles.</p>
                ) : (
                  <div className="space-y-2">
                    {laneMatching.theirDeliveriesToOurPickups.slice(0, 20).map((m, i) => (
                      <div key={i} className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 hover:bg-muted/40 transition-colors" data-testid={`match-pickup-${i}`}>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{m.customerLane}</p>
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            <span className="text-xs text-muted-foreground">Customer delivery:</span>
                            <span className="text-xs font-medium">{m.customerCity}, {m.customerState}</span>
                            <ArrowRightLeft className="h-3 w-3 text-muted-foreground" />
                            <span className="text-xs text-muted-foreground">We pick up at:</span>
                            <span className="text-xs font-medium">{m.ourCity}, {m.ourState}</span>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <Badge variant={m.distance < 25 ? "default" : "secondary"} className="text-xs">
                            {m.distance === 0 ? "Exact match" : `${m.distance} mi`}
                          </Badge>
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <TrendingUp className="h-3 w-3" />
                            {m.weeklyLoads}/wk · {m.customerVolume.toLocaleString()} vol
                          </div>
                          <span className="text-xs text-muted-foreground truncate max-w-28">{m.rfpTitle}</span>
                          {canReassign && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-indigo-300 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:text-indigo-400 mt-0.5"
                              onClick={() => openForceTask(
                                `Lane Match: ${m.customerLane}`,
                                `Lane Matching — Their Deliveries → Our Pickups\nCustomer Lane: ${m.customerLane}\nCustomer Delivery: ${m.customerCity}, ${m.customerState}\nWe Pick Up At: ${m.ourCity}, ${m.ourState}\nDistance: ${m.distance} mi\nFrequency: ${m.weeklyLoads}/wk\nVolume: ${m.customerVolume.toLocaleString()}\nRFP: ${m.rfpTitle}`
                              )}
                              data-testid={`button-force-task-match-pickup-${i}`}
                            >
                              <Zap className="h-3.5 w-3.5 mr-1" />
                              Force Task
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                    {laneMatching.theirDeliveriesToOurPickups.length > 20 && (
                      <p className="text-xs text-muted-foreground text-center pt-1">+{laneMatching.theirDeliveriesToOurPickups.length - 20} more matches</p>
                    )}
                  </div>
                )}
              </>
            )}
          </CardContent>
          )}
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
              Assign an existing contact or create a new one for this facility.
            </p>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <p className="text-sm font-medium">Select existing contact</p>
              <Select
                value={assignExistingContactId}
                onValueChange={setAssignExistingContactId}
              >
                <SelectTrigger data-testid="select-existing-contact">
                  <SelectValue placeholder="Choose a contact…" />
                </SelectTrigger>
                <SelectContent>
                  {(contacts || []).map((c) => (
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
                {assignContactToFacilityMutation.isPending ? "Assigning…" : "Assign to This Facility"}
              </Button>
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">or</span>
              </div>
            </div>

            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                setFindPlannerFacility(null);
                setAssignExistingContactId("");
                setContactDefaults({
                  lane: findPlannerFacility?.fullName,
                  region: findPlannerFacility?.state || undefined,
                });
                setEditingContact(undefined);
                setContactDialogOpen(true);
              }}
              data-testid="button-create-new-contact-for-facility"
            >
              <UserPlus className="h-4 w-4 mr-2" />
              Create New Contact
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
