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
  Pencil,
  Trash2,
  ExternalLink,
  Trophy,
  TrendingUp,
  ClipboardList,
  PhoneCall,
  Archive,
  ArchiveX,
  FileText,
  Activity,
  MoreHorizontal,
} from "lucide-react";
import { PinButton } from "@/components/pin-button";
import * as XLSX from "xlsx";
import { InfoTooltip } from "@/components/info-tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CompanyDialog } from "@/components/company-dialog";
import { ContactDialog } from "@/components/contact-dialog";
import { OrgChart } from "@/components/org-chart";
import { ContactList } from "@/components/contact-list";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { fmtMoney } from "@/lib/rep-utils";
import { TaskDialog } from "@/components/task-dialog";
import { CalloutDialog } from "@/components/callout-dialog";
import { ContactDetailSheet } from "@/components/contact-detail-sheet";
import { FileAttachmentUpload, FileAttachmentList, uploadPendingFiles, type PendingFile } from "@/components/file-attachment";
import { MarketShareCard } from "@/components/market-share-card";
import { RfpDialog } from "@/components/rfp-dialog";
import { AwardDialog } from "@/components/award-dialog";
import { ConvertToAwardDialog } from "@/components/convert-to-award-dialog";
import { PreCallPlanner } from "@/components/pre-call-planner";
import { ContactIntelModal } from "@/components/contact-intel-modal";
import { ZoomInfoSuggestionsDialog } from "@/components/zoominfo-suggestions";
import { OpportunityLogDialog } from "@/components/opportunity-log-dialog";
import { RelationshipFreightCompanyPortlet } from "@/components/relationship-freight-portlet";
import { OutlookComposeDialog } from "@/components/outlook-compose-dialog";
import { OverviewTab } from "./company-detail/tabs/OverviewTab";
import { ActivityTab } from "./company-detail/tabs/ActivityTab";
import { IntelTab } from "./company-detail/tabs/IntelTab";
import { PeopleTab } from "./company-detail/tabs/PeopleTab";
import { RfpTab } from "./company-detail/tabs/RfpTab";
import { OpportunitiesTab } from "./company-detail/tabs/OpportunitiesTab";
import { QuickTouchDialog } from "./company-detail/components/QuickTouchDialog";
import { TrendsDialog } from "./company-detail/components/TrendsDialog";
import { ImportContactsDialog } from "./company-detail/components/ImportContactsDialog";
import type { Company, Contact, User, Task, Callout, CalloutReaction, Touchpoint, Rfp, Award } from "@shared/schema";
import { GrowthScoreBadge } from "@/components/account-growth-portlet";
import { MomentumScoreDrawer } from "@/components/momentum-score-drawer";
import type { MomentumBreakdown } from "@/components/momentum-score-drawer";
import type {
  TouchLogEntry, MonthBucket, HealthScore, SharedRepEntry, TaskWithCount, AccountPerf,
} from "./company-detail/types";
import { useRecentlyVisited } from "@/hooks/use-recently-visited";

export default function CompanyDetail() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const searchString = useSearch();
  const rfpIntelTab = new URLSearchParams(searchString).get("rfpTab") || "coverage";
  const { toast } = useToast();
  const { user: currentUser } = useAuth();
  const companyId = params.id!;

  const [editCompanyOpen, setEditCompanyOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | null>(null);
  const [confirmDeleteCalloutId, setConfirmDeleteCalloutId] = useState<string | null>(null);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | undefined>();
  const [contactDefaults, setContactDefaults] = useState<{ lane?: string; region?: string } | undefined>();
  const [viewContact, setViewContact] = useState<Contact | null>(null);
  const [intelContact, setIntelContact] = useState<Contact | null>(null);
  const [orgEmailContact, setOrgEmailContact] = useState<Contact | null>(null);
  const [quickTouchOpen, setQuickTouchOpen] = useState(false);
  const [quickTouchContactId, setQuickTouchContactId] = useState("");
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [editingTaskItem, setEditingTaskItem] = useState<TaskWithCount | undefined>();
  const [focusTaskComments, setFocusTaskComments] = useState(false);
  const [forceLanePrefill, setForceLanePrefill] = useState<{ title: string; notes?: string; attachedLaneData?: any[]; opportunityId?: number } | undefined>();
  const [showTrends, setShowTrends] = useState(false);
  const [calloutDialogOpen, setCalloutDialogOpen] = useState(false);
  const [calloutReplyTo, setCalloutReplyTo] = useState<{ id: string; title: string } | undefined>();
  const [expandedCallouts, setExpandedCallouts] = useState<Set<string>>(new Set());
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [zoomInfoOpen, setZoomInfoOpen] = useState(false);
  const [preCallOpen, setPreCallOpen] = useState(false);
  const [oppLogOpen, setOppLogOpen] = useState(false);
  const [touchLogCollapsed, setTouchLogCollapsed] = useState(false);
  const [momentumDrawerOpen, setMomentumDrawerOpen] = useState(false);
  const [selectedTouchpoint, setSelectedTouchpoint] = useState<TouchLogEntry | null>(null);
  const [detailTab, setDetailTab] = useState<string>(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("rfpTab") && urlParams.get("rfpTab") !== "coverage") return "rfp";
    const tabParam = urlParams.get("tab");
    if (tabParam) return tabParam;
    return localStorage.getItem("cd_tab") || "overview";
  });

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

  useEffect(() => {
    if (rfpIntelTab !== "coverage") {
      setDetailTab("rfp");
      setTimeout(() => {
        const el = document.querySelector("[data-testid='card-rfp-intelligence']");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 450);
    }
  }, [rfpIntelTab]);

  const { trackVisit } = useRecentlyVisited(currentUser?.id);

  const { data: company, isLoading: companyLoading, isError: companyError, refetch: refetchCompany } = useQuery<Company>({
    queryKey: ["/api/companies", companyId],
    refetchOnMount: "always",
  });

  const { data: contacts, isLoading: contactsLoading } = useQuery<Contact[]>({
    queryKey: ["/api/companies", companyId, "contacts"],
  });

  const { data: allRfps = [] } = useQuery<Rfp[]>({ queryKey: ["/api/rfps"] });
  const { data: allAwards = [] } = useQuery<Award[]>({ queryKey: ["/api/awards"] });
  const urgentRfps = allRfps.filter(r => {
    if (r.companyId !== companyId || !r.dueDate) return false;
    const days = Math.ceil((new Date(r.dueDate + "T00:00:00").getTime() - Date.now()) / 86400000);
    return days >= 0 && days <= 14;
  }).map(r => ({ ...r, daysLeft: Math.ceil((new Date(r.dueDate! + "T00:00:00").getTime() - Date.now()) / 86400000) }));

  const { data: companyTouchpoints = [] } = useQuery<Touchpoint[]>({
    queryKey: ["/api/companies", companyId, "touchpoints"],
  });

  const { data: touchLogEntries = [] } = useQuery<TouchLogEntry[]>({
    queryKey: ["/api/companies", companyId, "touch-logs"],
    enabled: detailTab === "activity",
  });

  const { data: companyTasks = [] } = useQuery<TaskWithCount[]>({
    queryKey: ["/api/tasks/company", companyId],
    refetchInterval: 60000,
  });

  const { data: teamMembers = [] } = useQuery<Omit<User, "password">[]>({
    queryKey: ["/api/team-members"],
  });

  const { data: companyCallouts = [] } = useQuery<Callout[]>({
    queryKey: ["/api/callouts/company", companyId],
  });

  const { data: accountSummaryAll = [] } = useQuery<Array<{ customerName: string; totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue?: number; repName: string; byMonth?: Record<string, MonthBucket> }>>({
    queryKey: ["/api/financials/account-summary", "ytd"],
    queryFn: async () => {
      const res = await fetch("/api/financials/account-summary?period=ytd", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch account summary");
      return res.json();
    },
  });

  const { data: healthScore } = useQuery<HealthScore>({
    queryKey: ["/api/companies", companyId, "health-score"],
    staleTime: 60_000,
  });

  type GrowthScore = { score: number; band: string; bandLabel: string; bandColor: string; drivers: { label: string; points: number; positive: boolean }[]; breakdown?: MomentumBreakdown; calculatedAt?: string };
  const { data: growthScore, isLoading: growthScoreLoading } = useQuery<GrowthScore>({
    queryKey: ["/api/companies", companyId, "growth-score"],
    staleTime: 6 * 60 * 60 * 1000, // 6h — matches server cache window
  });

  useEffect(() => {
    if (!company) return;
    trackVisit({
      companyId: company.id,
      name: company.name,
      momentumLabel: growthScore?.bandLabel,
    });
  }, [company?.id, growthScore?.bandLabel]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: healthNarrative } = useQuery<{ narrative: string }>({
    queryKey: ["/api/companies", companyId, "health-narrative"],
    queryFn: () => apiRequest("POST", `/api/companies/${companyId}/health-narrative`, {
      score: healthScore!.score,
      grade: healthScore!.grade,
      factors: healthScore!.factors,
      momentum: healthScore!.momentum,
      momentumLabel: healthScore!.momentumLabel,
    }).then(r => r.json()),
    enabled: !!healthScore,
    staleTime: 15 * 60 * 1000,
  });

  const { data: claimsConfig } = useQuery<{ url: string | null }>({
    queryKey: ["/api/config/claims-url"],
    staleTime: 300_000,
  });

  const matchedPerf = (() => {
    if (!company) return null;
    // Normalize: lowercase, collapse whitespace, strip punctuation
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const crmNorm = normalize(company.name);
    const aliasNorms = company.financialAlias
      ? company.financialAlias.split(',').map(a => normalize(a.trim())).filter(Boolean)
      : [];
    const nameMatches = (crmToTest: string, excelNorm: string) => {
      if (excelNorm === crmToTest) return true;
      const shorter = crmToTest.length <= excelNorm.length ? crmToTest : excelNorm;
      const longer  = crmToTest.length <= excelNorm.length ? excelNorm : crmToTest;
      return shorter.length >= 5 && longer.includes(shorter);
    };
    const matches = accountSummaryAll.filter(r => {
      const excelNorm = normalize(r.customerName);
      if (aliasNorms.some(a => nameMatches(a, excelNorm))) return true;
      return nameMatches(crmNorm, excelNorm);
    });
    if (!matches.length) return null;
    const now = new Date();
    const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, "0")}`;
    const sumMonth = (key: string): MonthBucket =>
      matches.reduce((acc, r) => {
        const b = r.byMonth?.[key];
        if (!b) return acc;
        return { totalLoads: acc.totalLoads + b.totalLoads, spotLoads: acc.spotLoads + b.spotLoads, totalMargin: acc.totalMargin + b.totalMargin, totalRevenue: (acc.totalRevenue ?? 0) + (b.totalRevenue ?? 0) };
      }, { totalLoads: 0, spotLoads: 0, totalMargin: 0, totalRevenue: 0 } as MonthBucket);
    const ytd: MonthBucket = matches.reduce((acc, r) => {
      if (r.byMonth) {
        for (const b of Object.values(r.byMonth)) {
          acc.totalLoads += b.totalLoads;
          acc.spotLoads += b.spotLoads;
          acc.totalMargin += b.totalMargin;
          acc.totalRevenue = (acc.totalRevenue ?? 0) + (b.totalRevenue ?? 0);
        }
      } else {
        acc.totalLoads += r.totalLoads;
        acc.spotLoads += r.spotLoads;
        acc.totalMargin += r.totalMargin;
        acc.totalRevenue = (acc.totalRevenue ?? 0) + (r.totalRevenue ?? 0);
      }
      return acc;
    }, { totalLoads: 0, spotLoads: 0, totalMargin: 0, totalRevenue: 0 } as MonthBucket);
    return {
      repName:       matches[0].repName,
      ytd,
      thisMonth:     sumMonth(thisMonthKey),
      lastMonth:     sumMonth(lastMonthKey),
      thisMonthKey,
      lastMonthKey,
    };
  })();
  const accountPerf = matchedPerf;

  const { data: activityItems = [] } = useQuery<Array<{ type: string; title: string; description: string | null; date: string; userName: string | null }>>({
    queryKey: ["/api/companies", companyId, "activity"],
  });

  // ── RFP Track Record ─────────────────────────────────────────────────────
  const companyRfps = allRfps.filter(r => r.companyId === companyId);
  const companyAwards = allAwards.filter(a => a.companyId === companyId);
  const rfpWon = companyRfps.filter(r => r.status === "awarded" || r.status === "partially_awarded").length;
  const rfpLost = companyRfps.filter(r => r.status === "lost" || r.status === "declined").length;
  const rfpPending = companyRfps.filter(r => r.status === "pending" || r.status === "submitted").length;
  const rfpWinRate = companyRfps.length > 0 && (rfpWon + rfpLost) > 0
    ? Math.round((rfpWon / (rfpWon + rfpLost)) * 100) : null;
  const totalAwardValue = companyAwards.reduce((sum, a) => sum + (parseFloat(a.value ?? "0") || 0), 0);

  // ── Touchpoints this month ────────────────────────────────────────────────
  const now2 = new Date();
  const monthStart = new Date(now2.getFullYear(), now2.getMonth(), 1);
  const touchpointsThisMonth = companyTouchpoints.filter(tp => {
    const d = new Date(tp.date || (tp as any).createdAt || "");
    return d >= monthStart;
  }).length;

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

  const REACTION_EMOJIS = ["👍", "❤️", "🔥", "💡", "✅"];
  const canReact = currentUser?.role === "admin" || currentUser?.role === "director" || currentUser?.role === "sales_director";

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

  const canDeleteTouchpoints = currentUser?.role === "admin" || currentUser?.role === "director";
  const deleteTouchpointMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/touchpoints/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId] });
      queryClient.invalidateQueries({ queryKey: ["/api/touchpoints"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      toast({ title: "Touchpoint deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete touchpoint", variant: "destructive" });
    },
  });

  const canReassign = currentUser?.role === "admin" || currentUser?.role === "director" || currentUser?.role === "national_account_manager" || currentUser?.role === "sales" || currentUser?.role === "sales_director";

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

  const archiveMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/companies/${companyId}/archive`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId] });
      setArchiveDialogOpen(false);
      toast({ title: "Account archived", description: "This account is now parked in your archived list." });
    },
    onError: (error: Error) => {
      toast({ title: "Error archiving account", description: error.message, variant: "destructive" });
    },
  });

  const unarchiveMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/companies/${companyId}/unarchive`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId] });
      toast({ title: "Account restored", description: "This account is now active again." });
    },
    onError: (error: Error) => {
      toast({ title: "Error restoring account", description: error.message, variant: "destructive" });
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

  if (companyError) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-12">
        <Building2 className="h-12 w-12 text-muted-foreground/50" />
        <h2 className="text-lg font-medium">Could not load company</h2>
        <p className="text-sm text-muted-foreground">There was a problem loading this account.</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => refetchCompany()} data-testid="button-retry-company">
            Try again
          </Button>
          <Button variant="ghost" onClick={() => navigate("/customers")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Customers
          </Button>
        </div>
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
      <div className="sticky top-0 z-20 -mx-4 sm:-mx-6 px-4 sm:px-6 py-3 bg-background/95 backdrop-blur border-b border-border/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
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
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-semibold" data-testid="text-company-name">
                  {company.name}
                </h1>
                {!company.archivedAt && <PinButton companyId={companyId} size="default" className="h-8 w-8" />}
                {healthScore && (() => {
                  const colorMap: Record<string, string> = {
                    green: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-800",
                    blue:  "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 border-blue-200 dark:border-blue-800",
                    amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800",
                    red:   "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800",
                  };
                  const momentumIcon = healthScore.momentum === "up" ? "↑" : healthScore.momentum === "down" ? "↓" : "→";
                  const momentumColor = healthScore.momentum === "up" ? "text-green-600 dark:text-green-400" : healthScore.momentum === "down" ? "text-red-500 dark:text-red-400" : "text-muted-foreground";
                  return (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => setPreCallOpen(true)}
                          className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border cursor-pointer hover:opacity-80 transition-opacity ${colorMap[healthScore.color] ?? colorMap.amber}`}
                          title="Click to open Pre-Call Brief"
                          data-testid="badge-health-score"
                        >
                          <Activity className="h-3 w-3" />
                          {healthScore.grade} · {healthScore.score}/100
                        </button>
                        <InfoTooltip
                          text="Relationship health is a 0–100 score built from 5 factors: how recently and frequently you've touched the account, how many contacts you have, whether there's an active RFP, and whether financial data matches. Click the badge to see the full breakdown."
                          side="bottom"
                        />
                        <span
                          className={`text-sm font-bold ${momentumColor}`}
                          data-testid="badge-momentum"
                        >
                          {momentumIcon}
                        </span>
                        <InfoTooltip
                          text={`Momentum compares your touch count from the last 30 days vs the prior 30 days. ${healthScore.momentumLabel || ""} ↑ = engaging more, ↓ = dropping off, → = steady.`}
                          side="bottom"
                        />
                      </div>
                      {healthNarrative?.narrative && (
                        <p className="text-xs text-muted-foreground italic leading-relaxed max-w-md" data-testid="health-narrative">{healthNarrative.narrative}</p>
                      )}
                      {growthScore && (
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <GrowthScoreBadge
                            score={growthScore.score}
                            band={growthScore.band}
                            bandLabel={growthScore.bandLabel}
                            onClick={(e) => { e.stopPropagation(); setMomentumDrawerOpen(true); }}
                          />
                          {growthScore.drivers.length > 0 && (
                            <span className="text-xs text-muted-foreground" title={growthScore.drivers.map(d => `${d.positive ? "↑" : "↓"} ${d.label}`).join(" · ")}>
                              — {growthScore.drivers[0].positive ? "↑" : "↓"} {growthScore.drivers[0].label}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
              <div className="flex items-center gap-2 text-muted-foreground flex-wrap">
                {company.industry && (
                  <Badge variant="secondary">{company.industry}</Badge>
                )}
                {(company as any).shippingModes && (company as any).shippingModes.length > 0 && (
                  (company as any).shippingModes.map((mode: string) => (
                    <Badge key={mode} variant="outline" className="text-[11px] border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-400">{mode}</Badge>
                  ))
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
          {contacts && contacts.length > 0 && !company.archivedAt && (
            <Button
              variant="outline"
              onClick={() => { setQuickTouchOpen(true); setQuickTouchContactId(contacts[0]?.id ?? ""); }}
              data-testid="button-log-touch-header"
            >
              <PhoneCall className="h-4 w-4 mr-2" />
              Log Touch
            </Button>
          )}

          {!company.archivedAt && (
            <Button variant="outline" onClick={() => setOppLogOpen(true)} data-testid="button-log-opportunity" className="gap-1">
              <Trophy className="h-4 w-4 text-amber-500" />
              Log Win / Opp
            </Button>
          )}

          {!company.archivedAt && (
            <Button variant="outline" onClick={() => setPreCallOpen(true)} data-testid="button-precall-brief">
              <ClipboardList className="h-4 w-4 mr-2" />
              Pre-Call Brief
            </Button>
          )}

          <div className="relative inline-flex">
            <Button variant="outline" onClick={() => { setDetailTab("rfp"); localStorage.setItem("cd_tab", "rfp"); setTimeout(() => { document.querySelector('[data-testid="tab-detail-rfp"]')?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, 50); }} data-testid="button-rfp-awards">
              <Trophy className="h-4 w-4 mr-2" />
              RFP & Awards
            </Button>
            {urgentRfps.length > 0 && (
              <span
                className="absolute -top-2 -right-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold px-1 shadow-sm cursor-default"
                title={urgentRfps.map(r => `${r.title}: ${r.daysLeft}d left`).join(", ")}
                data-testid="badge-rfp-deadline"
              >
                {urgentRfps[0].daysLeft === 0 ? "Today" : `${urgentRfps[0].daysLeft}d`}
              </span>
            )}
          </div>

          <Button variant="outline" onClick={() => setShowTrends(true)} data-testid="button-account-trends">
            <TrendingUp className="h-4 w-4 mr-2" />
            Trends
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" data-testid="button-more-actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {claimsConfig?.url && (
                <DropdownMenuItem asChild data-testid="dropdown-item-claims">
                  <a href={claimsConfig.url} target="_blank" rel="noopener noreferrer" className="flex items-center cursor-pointer">
                    <FileText className="h-4 w-4 mr-2" />
                    Claims
                  </a>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setEditCompanyOpen(true)} data-testid="dropdown-item-edit">
                <Pencil className="h-4 w-4 mr-2" />
                Edit
              </DropdownMenuItem>
              {company.archivedAt ? (
                <DropdownMenuItem
                  onClick={() => unarchiveMutation.mutate()}
                  disabled={unarchiveMutation.isPending}
                  data-testid="dropdown-item-restore"
                >
                  <ArchiveX className="h-4 w-4 mr-2" />
                  {unarchiveMutation.isPending ? "Restoring..." : "Restore"}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => setArchiveDialogOpen(true)} data-testid="dropdown-item-archive">
                  <Archive className="h-4 w-4 mr-2" />
                  Archive
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => setDeleteDialogOpen(true)}
                data-testid="dropdown-item-delete"
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {company.archivedAt && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30 px-4 py-3">
          <Archive className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <p className="text-sm text-amber-700 dark:text-amber-400">
            This account was archived on {new Date(company.archivedAt).toLocaleDateString()}. It is hidden from the active customers list.
          </p>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => unarchiveMutation.mutate()} disabled={unarchiveMutation.isPending}>
            <ArchiveX className="h-3.5 w-3.5 mr-1.5" />
            Restore
          </Button>
        </div>
      )}

      <Tabs value={detailTab} onValueChange={(t) => { setDetailTab(t); localStorage.setItem("cd_tab", t); }}>
        <TabsList className="w-full grid grid-cols-6 mb-1">
          <TabsTrigger value="overview" data-testid="tab-detail-overview">Overview</TabsTrigger>
          <TabsTrigger value="activity" data-testid="tab-detail-activity">Activity</TabsTrigger>
          <TabsTrigger value="intelligence" data-testid="tab-detail-intelligence">Intel</TabsTrigger>
          <TabsTrigger value="people" data-testid="tab-detail-people">People</TabsTrigger>
          <TabsTrigger value="opportunities" data-testid="tab-detail-opportunities">Opportunities</TabsTrigger>
          <TabsTrigger value="rfp" data-testid="tab-detail-rfp">RFP & Lanes</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-2">
          <OverviewTab
            accountPerf={accountPerf}
            setShowTrends={setShowTrends}
            companyRfps={companyRfps}
            rfpWon={rfpWon}
            rfpLost={rfpLost}
            rfpPending={rfpPending}
            rfpWinRate={rfpWinRate}
            totalAwardValue={totalAwardValue}
            companyId={companyId}
            companyName={company!.name}
            isLeadership={currentUser?.role === "director" || currentUser?.role === "national_account_manager" || currentUser?.role === "sales_director" || currentUser?.role === "admin"}
            onNbaLogTouch={() => setQuickTouchOpen(true)}
            onNbaCreateTask={() => setTaskDialogOpen(true)}
            onNbaViewRfp={() => {
              setDetailTab("rfp");
              localStorage.setItem("cd_tab", "rfp");
              setTimeout(() => {
                document
                  .querySelector('[data-testid="tab-detail-rfp"]')
                  ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
              }, 50);
            }}
            onOpenContact={(contactId) => {
              const contact = contacts?.find(c => c.id === contactId);
              if (contact) setViewContact(contact);
            }}
          />
        </TabsContent>

        {/* ── Activity tab: Tasks, Callouts, Touch Log ── */}
        <TabsContent value="activity" className="space-y-4 mt-2">
          <ActivityTab
            touchLogEntries={touchLogEntries}
            companyTasks={companyTasks}
            teamMembers={teamMembers}
            topLevelCompanyCallouts={topLevelCompanyCallouts}
            companyCalloutRepliesFor={companyCalloutRepliesFor}
            calloutReactions={calloutReactions}
            canReact={canReact}
            expandedCallouts={expandedCallouts}
            toggleCalloutExpanded={toggleCalloutExpanded}
            setCalloutReplyTo={setCalloutReplyTo}
            setCalloutDialogOpen={setCalloutDialogOpen}
            setSelectedTouchpoint={setSelectedTouchpoint}
            touchLogCollapsed={touchLogCollapsed}
            setTouchLogCollapsed={setTouchLogCollapsed}
            deleteCalloutMutation={deleteCalloutMutation}
            deleteTouchpointMutation={canDeleteTouchpoints ? deleteTouchpointMutation : undefined}
            toggleReactionMutation={toggleReactionMutation}
            toggleTaskStatus={toggleTaskStatus}
            deleteTaskMutation={deleteTaskMutation}
            currentUser={currentUser}
            setConfirmDeleteCalloutId={setConfirmDeleteCalloutId}
            setTaskDialogOpen={setTaskDialogOpen}
            setEditingTaskItem={setEditingTaskItem}
            setForceLanePrefill={setForceLanePrefill}
            setFocusTaskComments={setFocusTaskComments}
          />
        </TabsContent>

        <TabsContent value="intelligence" className="space-y-4 mt-2">
          <IntelTab
            company={company!}
            companyId={companyId}
            currentUser={currentUser}
            teamMembers={teamMembers}
            companyRfps={companyRfps}
            accountPerf={accountPerf}
            selectedTouchpoint={selectedTouchpoint}
            setSelectedTouchpoint={setSelectedTouchpoint}
          />
        </TabsContent>

        <TabsContent value="people" className="space-y-4 mt-2">
          <PeopleTab
            company={company!}
            contacts={contacts}
            companyTouchpoints={companyTouchpoints}
            activityItems={activityItems}
            handleAddContact={handleAddContact}
            handleEditContact={handleEditContact}
            setZoomInfoOpen={setZoomInfoOpen}
            setImportDialogOpen={setImportDialogOpen}
            setViewContact={setViewContact}
            setIntelContact={setIntelContact}
            onLogTouch={(id) => { setQuickTouchContactId(id); setQuickTouchOpen(true); }}
            setEditingTaskItem={setEditingTaskItem}
            setForceLanePrefill={setForceLanePrefill}
            setTaskDialogOpen={setTaskDialogOpen}
            setOrgEmailContact={setOrgEmailContact}
            currentUser={currentUser}
          />
        </TabsContent>

        <TabsContent value="opportunities" className="space-y-4 mt-2">
          <OpportunitiesTab
            companyId={companyId}
            companyName={company!.name}
            onCreateTask={(title, notes, opportunityId) => {
              setForceLanePrefill({ title, notes, opportunityId });
              setEditingTaskItem(undefined);
              setTaskDialogOpen(true);
            }}
          />
        </TabsContent>

        <TabsContent value="rfp" className="space-y-4 mt-2">
          <RfpTab
            company={company!}
            companyId={companyId}
            companyRfps={companyRfps}
            companyAwards={companyAwards}
            contacts={contacts}
            companyTouchpoints={companyTouchpoints}
            touchpointsThisMonth={touchpointsThisMonth}
            rfpIntelDefaultTab={rfpIntelTab}
            canReassign={canReassign}
            handleEditContact={handleEditContact}
            setViewContact={setViewContact}
            setTaskDialogOpen={setTaskDialogOpen}
            setEditingTaskItem={setEditingTaskItem}
            setForceLanePrefill={setForceLanePrefill}
            onCreateContactForFacility={(defaults) => {
              setContactDefaults(defaults);
              setEditingContact(undefined);
              setContactDialogOpen(true);
            }}
          />
        </TabsContent>
      </Tabs>

      <TaskDialog
        open={taskDialogOpen}
        onOpenChange={(open) => {
          setTaskDialogOpen(open);
          if (!open) { setForceLanePrefill(undefined); setFocusTaskComments(false); }
        }}
        companyId={companyId}
        editingTask={editingTaskItem}
        prefillData={forceLanePrefill}
        focusComments={focusTaskComments}
      />

      <CalloutDialog
        open={calloutDialogOpen}
        onOpenChange={setCalloutDialogOpen}
        companyId={companyId}
        parentId={calloutReplyTo?.id}
        parentTitle={calloutReplyTo?.title}
      />

      <OpportunityLogDialog
        open={oppLogOpen}
        onOpenChange={setOppLogOpen}
        companyId={companyId}
        companyName={company.name}
      />

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

      <AlertDialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {company.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This account will be hidden from the active customers list. All contacts, RFPs, and history are preserved. You can restore it at any time from the Archived view.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => archiveMutation.mutate()} disabled={archiveMutation.isPending} data-testid="button-confirm-archive">
              {archiveMutation.isPending ? "Archiving..." : "Archive Account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirmDeleteTaskId} onOpenChange={open => !open && setConfirmDeleteTaskId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete task?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently remove the task. This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { if (confirmDeleteTaskId) { deleteTaskMutation.mutate(confirmDeleteTaskId); setConfirmDeleteTaskId(null); } }} data-testid="button-confirm-delete-task">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirmDeleteCalloutId} onOpenChange={open => !open && setConfirmDeleteCalloutId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete post?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently remove this callout or reply. This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { if (confirmDeleteCalloutId) { deleteCalloutMutation.mutate(confirmDeleteCalloutId); setConfirmDeleteCalloutId(null); } }} data-testid="button-confirm-delete-callout">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ImportContactsDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} companyId={companyId} />

      <ContactDetailSheet
        contact={viewContact}
        open={!!viewContact}
        onClose={() => setViewContact(null)}
        onEdit={(c) => { setViewContact(null); handleEditContact(c); }}
        onDeleted={() => setViewContact(null)}
      />

      {intelContact && (
        <ContactIntelModal
          contact={intelContact}
          open={!!intelContact}
          onClose={() => setIntelContact(null)}
        />
      )}

      {orgEmailContact && (
        <OutlookComposeDialog
          open={!!orgEmailContact}
          onClose={() => setOrgEmailContact(null)}
          toEmail={orgEmailContact.email ?? ""}
          toName={orgEmailContact.name}
          defaultSubject=""
          companyName={company.name}
          contactId={orgEmailContact.id}
          companyId={company.id}
        />
      )}

      <ZoomInfoSuggestionsDialog
        open={zoomInfoOpen}
        onClose={() => setZoomInfoOpen(false)}
        companyId={company.id}
        companyName={company.name}
      />

      <QuickTouchDialog
        open={quickTouchOpen}
        onOpenChange={open => { setQuickTouchOpen(open); if (!open) setQuickTouchContactId(""); }}
        companyId={companyId}
        companyName={company.name}
        contacts={contacts}
        initialContactId={quickTouchContactId}
      />

      <TrendsDialog
        open={showTrends}
        onOpenChange={setShowTrends}
        companyId={companyId}
        companyName={company.name}
        financialAlias={company.financialAlias}
      />
      {company && (
        <PreCallPlanner
          open={preCallOpen}
          onClose={() => setPreCallOpen(false)}
          company={company}
          contacts={contacts ?? []}
          touchpoints={companyTouchpoints}
          tasks={companyTasks}
          rfps={allRfps}
          awards={allAwards}
          financialSummary={matchedPerf?.ytd ?? null}
          healthScore={healthScore}
        />
      )}

      <MomentumScoreDrawer
        open={momentumDrawerOpen}
        onClose={() => setMomentumDrawerOpen(false)}
        companyName={company?.name ?? ""}
        scoreData={growthScore}
        isLoading={growthScoreLoading}
      />
    </div>
  );
}
