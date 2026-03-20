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
  PhoneCall,
  Archive,
  ArchiveX,
  Upload,
  FileSpreadsheet,
  DollarSign,
  AlertCircle,
  FileText,
  Mail,
} from "lucide-react";
import * as XLSX from "xlsx";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartTooltip,
  ResponsiveContainer, ComposedChart, Line, Legend,
} from "recharts";
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
import { ContactDetailSheet } from "@/components/contact-detail-sheet";
import { FileAttachmentUpload, FileAttachmentList, uploadPendingFiles, type PendingFile } from "@/components/file-attachment";
import { MarketShareCard } from "@/components/market-share-card";
import type { Company, Contact, User, Task, Callout, CalloutReaction, Touchpoint, Rfp, Award } from "@shared/schema";
type TaskWithCount = Task & { commentCount?: number };

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
  ourCity: string;
  ourState: string;
  ourWeeklyLoads: number;
  ourTotalLoads: number;
  customerCity: string;
  customerState: string;
  distance: number;
  totalVolume: number;
  matchingLanes: Array<{ rfpTitle: string; rfpId: string; lane: string; volume: number }>;
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
  const [tenderStyle, setTenderStyle] = useState("");
  const [accountQuirks, setAccountQuirks] = useState("");
  const [processNotes, setProcessNotes] = useState("");
  const [spotProcess, setSpotProcess] = useState("");
  const [dlEmail, setDlEmail] = useState("");
  const [financialAliasEdit, setFinancialAliasEdit] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTo, setTransferTo] = useState("");
  const [viewContact, setViewContact] = useState<Contact | null>(null);
  const [expandedDeliveries, setExpandedDeliveries] = useState<Set<number>>(new Set());
  const [expandedPickups, setExpandedPickups] = useState<Set<number>>(new Set());
  const toggleExpanded = (set: Set<number>, idx: number, setter: (s: Set<number>) => void) => {
    const next = new Set(set);
    next.has(idx) ? next.delete(idx) : next.add(idx);
    setter(next);
  };
  const [quickTouchOpen, setQuickTouchOpen] = useState(false);
  const [quickTouchContactId, setQuickTouchContactId] = useState("");
  const [quickTouchType, setQuickTouchType] = useState("call");
  const [quickTouchNote, setQuickTouchNote] = useState("");
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [editingTaskItem, setEditingTaskItem] = useState<TaskWithCount | undefined>();
  const [focusTaskComments, setFocusTaskComments] = useState(false);
  const [forceLanePrefill, setForceLanePrefill] = useState<{ title: string; notes?: string; attachedLaneData?: any[] } | undefined>();
  const [lanesCollapsed, setLanesCollapsed] = useState(false);
  const [scorecardPending, setScorecardPending] = useState<PendingFile[]>([]);
  const [scorecardUploading, setScorecardUploading] = useState(false);
  const [rfpIntelCollapsed, setRfpIntelCollapsed] = useState(false);
  const [showTrends, setShowTrends] = useState(false);
  const [calloutDialogOpen, setCalloutDialogOpen] = useState(false);
  const [calloutReplyTo, setCalloutReplyTo] = useState<{ id: string; title: string } | undefined>();
  const [expandedCallouts, setExpandedCallouts] = useState<Set<string>>(new Set());
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importRows, setImportRows] = useState<any[]>([]);
  const [importFileName, setImportFileName] = useState("");

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

  const { data: allRfps = [] } = useQuery<Rfp[]>({ queryKey: ["/api/rfps"] });
  const { data: allAwards = [] } = useQuery<Award[]>({ queryKey: ["/api/awards"] });
  const { data: customerNames = [] } = useQuery<string[]>({
    queryKey: ["/api/financials/customer-names"],
    enabled: showTrends,
  });
  const urgentRfps = allRfps.filter(r => {
    if (r.companyId !== companyId || !r.dueDate) return false;
    const days = Math.ceil((new Date(r.dueDate + "T00:00:00").getTime() - Date.now()) / 86400000);
    return days >= 0 && days <= 14;
  }).map(r => ({ ...r, daysLeft: Math.ceil((new Date(r.dueDate! + "T00:00:00").getTime() - Date.now()) / 86400000) }));

  const { data: companyTouchpoints = [] } = useQuery<Touchpoint[]>({
    queryKey: ["/api/companies", companyId, "touchpoints"],
    enabled: !!companyId,
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

  const { data: vendorRoutedKeys = [] } = useQuery<string[]>({
    queryKey: ["/api/companies", companyId, "vendor-routed"],
  });

  const vendorRoutedToggle = useMutation({
    mutationFn: async (rowKey: string) => {
      const res = await apiRequest("POST", `/api/companies/${companyId}/vendor-routed/toggle`, { rowKey });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "vendor-routed"] });
    },
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

  type MonthBucket = { totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue?: number };
  const { data: accountSummaryAll = [] } = useQuery<Array<{ customerName: string; totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue?: number; repName: string; byMonth?: Record<string, MonthBucket> }>>({
    queryKey: ["/api/financials/account-summary"],
  });
  const matchedPerf = (() => {
    if (!company) return null;
    // Normalize: lowercase, collapse whitespace, strip punctuation
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const crmNorm = normalize(company.name);
    const aliasNorm = company.financialAlias ? normalize(company.financialAlias) : null;
    const nameMatches = (crmToTest: string, excelNorm: string) => {
      if (excelNorm === crmToTest) return true;
      const shorter = crmToTest.length <= excelNorm.length ? crmToTest : excelNorm;
      const longer  = crmToTest.length <= excelNorm.length ? excelNorm : crmToTest;
      return shorter.length >= 5 && longer.includes(shorter);
    };
    const matches = accountSummaryAll.filter(r => {
      const excelNorm = normalize(r.customerName);
      if (aliasNorm && nameMatches(aliasNorm, excelNorm)) return true;
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
        return { totalLoads: acc.totalLoads + b.totalLoads, spotLoads: acc.spotLoads + b.spotLoads, totalMargin: acc.totalMargin + b.totalMargin };
      }, { totalLoads: 0, spotLoads: 0, totalMargin: 0 });
    return {
      repName:       matches[0].repName,
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

  type TrendMonth = { monthKey: string; totalLoads: number; spotLoads: number; totalMargin: number };
  type TrendDest = { city: string; state: string; count: number };
  type TrendCorridor = { origin: string; destination: string; loads: number };
  type TrendsData = { months: TrendMonth[]; destinations: TrendDest[]; corridors: TrendCorridor[]; totalLoads: number; spotLoads: number; totalMargin: number };
  const { data: trendsData, isLoading: trendsLoading } = useQuery<TrendsData>({
    queryKey: ["/api/companies", companyId, "historical-trends"],
    enabled: showTrends,
  });

  // ── RFP Track Record ─────────────────────────────────────────────────────
  const companyRfps = allRfps.filter(r => r.companyId === companyId);
  const companyAwards = allAwards.filter(a => a.companyId === companyId);
  const rfpWon = companyRfps.filter(r => r.status === "awarded" || r.status === "partially_awarded").length;
  const rfpLost = companyRfps.filter(r => r.status === "lost").length;
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

  // ── Alias suggestions for trends ─────────────────────────────────────────
  const trendAliasSuggestions = (() => {
    if (!company || customerNames.length === 0) return [];
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const crmNorm = normalize(company.name);
    return customerNames
      .filter(n => {
        const norm = normalize(n);
        const shorter = crmNorm.length <= norm.length ? crmNorm : norm;
        const longer  = crmNorm.length <= norm.length ? norm : crmNorm;
        return shorter.length >= 4 && longer.includes(shorter);
      })
      .slice(0, 5);
  })();

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

  const logTouchFromDetailMutation = useMutation({
    mutationFn: ({ contactId, type, notes }: { contactId: string; type: string; notes: string }) =>
      apiRequest("POST", `/api/contacts/${contactId}/touchpoints`, { type, date: new Date().toISOString().slice(0, 10), notes }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/touchpoints/company-summary"] });
      toast({ title: "Touch logged!" });
      setQuickTouchOpen(false);
      setQuickTouchContactId("");
      setQuickTouchType("call");
      setQuickTouchNote("");
    },
    onError: () => toast({ title: "Failed to log touch", variant: "destructive" }),
  });

  const canReassign = currentUser?.role === "admin" || currentUser?.role === "director" || currentUser?.role === "national_account_manager" || currentUser?.role === "sales" || currentUser?.role === "sales_director";
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
        financialAlias: financialAliasEdit.trim() || null,
        tenderStyle: tenderStyle || null,
        accountQuirks: accountQuirks || null,
        processNotes: processNotes || null,
        spotProcess: spotProcess || null,
        dlEmail: dlEmail || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId] });
      setPortalEdit(false);
      toast({ title: "Account info saved", className: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800" });
    },
    onError: () => toast({ title: "Failed to save account info", variant: "destructive" }),
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
    setFinancialAliasEdit(company?.financialAlias || "");
    setTenderStyle(company?.tenderStyle || "");
    setAccountQuirks(company?.accountQuirks || "");
    setProcessNotes(company?.processNotes || "");
    setSpotProcess(company?.spotProcess || "");
    setDlEmail(company?.dlEmail || "");
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

  const bulkImportMutation = useMutation({
    mutationFn: async (rows: any[]) => {
      const res = await apiRequest("POST", `/api/companies/${companyId}/contacts/bulk-import`, { contacts: rows });
      return res;
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      setImportDialogOpen(false);
      setImportRows([]);
      setImportFileName("");
      toast({ title: `Imported ${data.count} contact${data.count !== 1 ? "s" : ""}`, description: "Contacts have been added to this account." });
    },
    onError: (error: Error) => {
      toast({ title: "Import failed", description: error.message, variant: "destructive" });
    },
  });

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const data = ev.target?.result;
      const wb = XLSX.read(data, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw: any[] = XLSX.utils.sheet_to_json(ws, { defval: "" });
      const normalized = raw.map(r => {
        const keys = Object.keys(r);
        const find = (candidates: string[]) => {
          for (const c of candidates) {
            const k = keys.find(k => k.toLowerCase().replace(/[\s_-]/g, "").includes(c.toLowerCase().replace(/[\s_-]/g, "")));
            if (k && r[k]) return String(r[k]).trim();
          }
          return "";
        };
        return {
          name: find(["name", "fullname", "contactname", "contact"]),
          title: find(["title", "jobtitle", "position", "role"]),
          email: find(["email", "emailaddress", "mail"]),
          phone: find(["phone", "phonenumber", "mobile", "cell", "telephone"]),
          notes: find(["notes", "note", "comments", "comment"]),
          nextSteps: find(["nextsteps", "nextstep", "next steps", "next step", "action"]),
        };
      }).filter(r => r.name.length > 0);
      setImportRows(normalized);
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  }

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

          <div className="relative inline-flex">
            <Button variant="outline" onClick={() => navigate("/rfp-awards")} data-testid="button-rfp-awards">
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
          {company.archivedAt ? (
            <Button variant="outline" onClick={() => unarchiveMutation.mutate()} disabled={unarchiveMutation.isPending} data-testid="button-unarchive-company">
              <ArchiveX className="h-4 w-4 mr-2" />
              {unarchiveMutation.isPending ? "Restoring..." : "Restore"}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => setArchiveDialogOpen(true)} data-testid="button-archive-company">
              <Archive className="h-4 w-4 mr-2" />
              Archive
            </Button>
          )}
          <Button variant="outline" onClick={() => setDeleteDialogOpen(true)} data-testid="button-delete-company">
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </Button>
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

      {/* Account Performance (from uploaded summary data) */}
      {accountPerf && (() => {
        const fmtMargin = (m: number) => m >= 1000 ? `$${(m / 1000).toFixed(1)}K` : `$${m.toLocaleString()}`;
        const fmtMonth = (key: string) => {
          const [y, mo] = key.split("-");
          return new Date(parseInt(y), parseInt(mo) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
        };
        const PerfGrid = ({ bucket, label }: { bucket: { totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue?: number }; label: string }) => {
          const marginPct = (bucket.totalRevenue ?? 0) > 0 ? (bucket.totalMargin / bucket.totalRevenue!) * 100 : null;
          return (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">{label}</p>
            <div className={`grid gap-2 ${marginPct !== null ? "grid-cols-4" : "grid-cols-3"}`}>
              <div className="rounded-lg bg-muted/50 p-2.5 text-center">
                <p className="text-xl font-bold text-blue-600 dark:text-blue-400">{bucket.totalLoads.toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Total Loads</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-2.5 text-center">
                <p className="text-xl font-bold text-amber-600 dark:text-amber-400">{bucket.spotLoads.toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Spot Loads</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-2.5 text-center">
                <p className="text-xl font-bold text-green-600 dark:text-green-400">{fmtMargin(bucket.totalMargin)}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Margin</p>
              </div>
              {marginPct !== null && (
                <div className="rounded-lg bg-muted/50 p-2.5 text-center">
                  <p className={`text-xl font-bold ${marginPct < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>{marginPct.toFixed(1)}%</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Margin %</p>
                </div>
              )}
            </div>
            {bucket.totalLoads > 0 && (
              <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
                <span>{Math.round((bucket.spotLoads / bucket.totalLoads) * 100)}% spot</span>
                <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-blue-500" />
                <span>{Math.round(((bucket.totalLoads - bucket.spotLoads) / bucket.totalLoads) * 100)}% contract</span>
              </div>
            )}
          </div>
          );
        };
        return (
          <Card data-testid="card-account-performance">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                Account Performance
                {accountPerf.repName && (
                  <Badge variant="secondary" className="ml-auto text-xs font-normal">{accountPerf.repName}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-4">
              <PerfGrid bucket={accountPerf.thisMonth} label={fmtMonth(accountPerf.thisMonthKey)} />
              <div className="border-t" />
              <PerfGrid bucket={accountPerf.lastMonth} label={fmtMonth(accountPerf.lastMonthKey)} />
              <div className="border-t pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-muted-foreground hover:text-foreground gap-2"
                  onClick={() => setShowTrends(true)}
                  data-testid="button-view-trends"
                >
                  <TrendingUp className="h-3.5 w-3.5" />
                  View Historical Trends
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* RFP Track Record */}
      {companyRfps.length > 0 && (
        <Card data-testid="card-rfp-track-record">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Trophy className="h-4 w-4 text-amber-500" />
              RFP Track Record
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            <div className="grid grid-cols-4 gap-2 text-center">
              <div className="rounded-lg bg-muted/50 p-2">
                <p className="text-lg font-bold">{companyRfps.length}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Total</p>
              </div>
              <div className="rounded-lg bg-green-50 dark:bg-green-950/30 p-2">
                <p className="text-lg font-bold text-green-600 dark:text-green-400">{rfpWon}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Won</p>
              </div>
              <div className="rounded-lg bg-red-50 dark:bg-red-950/30 p-2">
                <p className="text-lg font-bold text-red-500 dark:text-red-400">{rfpLost}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Lost</p>
              </div>
              <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 p-2">
                <p className="text-lg font-bold text-amber-600 dark:text-amber-400">{rfpPending}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Open</p>
              </div>
            </div>
            {rfpWinRate !== null && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Win Rate</span>
                  <span className="font-semibold text-green-600 dark:text-green-400">{rfpWinRate}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-green-500 transition-all" style={{ width: `${rfpWinRate}%` }} />
                </div>
              </div>
            )}
            {totalAwardValue > 0 && (
              <div className="flex items-center justify-between text-xs pt-1 border-t">
                <span className="text-muted-foreground flex items-center gap-1"><DollarSign className="h-3 w-3" />Total Awarded Value</span>
                <span className="font-semibold">${totalAwardValue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Account Information */}
      <Card data-testid="card-portal-info">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Globe className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              Account Information
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
            <div className="space-y-4">
              {/* Portal Credentials Section */}
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Portal Credentials</p>
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
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><DollarSign className="h-3 w-3" /> Financial Name</label>
                    <input
                      className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder={`Default: ${company!.name}`}
                      value={financialAliasEdit}
                      onChange={e => setFinancialAliasEdit(e.target.value)}
                      data-testid="input-financial-alias"
                    />
                    <p className="text-[11px] text-muted-foreground">Alternate name used to match this account in uploaded financial data. Leave blank to use the account name.</p>
                  </div>
                </div>
              </div>

              {/* Account Intelligence Section */}
              <div className="border-t pt-4">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Account Intelligence</p>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><TruckIcon className="h-3 w-3" /> Tendering Process</label>
                    <input
                      className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="e.g. TMS portal, email, phone, EDI…"
                      value={tenderStyle}
                      onChange={e => setTenderStyle(e.target.value)}
                      data-testid="input-tender-style"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Zap className="h-3 w-3" /> Spot Process</label>
                    <input
                      className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="e.g. Portal, Email…"
                      value={spotProcess}
                      onChange={e => setSpotProcess(e.target.value)}
                      data-testid="input-spot-process"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Mail className="h-3 w-3" /> D/L Email</label>
                    <input
                      className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                      type="email"
                      placeholder="dispatch@customer.com"
                      value={dlEmail}
                      onChange={e => setDlEmail(e.target.value)}
                      data-testid="input-dl-email"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><AlertCircle className="h-3 w-3" /> Account Quirks</label>
                    <textarea
                      className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                      rows={3}
                      placeholder="Special requirements, sensitivities, things to know…"
                      value={accountQuirks}
                      onChange={e => setAccountQuirks(e.target.value)}
                      data-testid="input-account-quirks"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><FileText className="h-3 w-3" /> Process Notes</label>
                    <textarea
                      className="w-full border rounded-md px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                      rows={3}
                      placeholder="Standard operating procedures, workflows, key steps…"
                      value={processNotes}
                      onChange={e => setProcessNotes(e.target.value)}
                      data-testid="input-process-notes"
                    />
                  </div>
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
            <div className="space-y-4">
              {/* Portal Credentials */}
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Portal Credentials</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                  <div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><DollarSign className="h-3 w-3" /> Financial Name</p>
                    <p className="text-sm" data-testid="text-financial-alias">
                      {company.financialAlias ?? <span className="text-muted-foreground italic">{company.name} (default)</span>}
                    </p>
                  </div>
                </div>
              </div>

              {/* Account Intelligence */}
              {(company.tenderStyle || company.spotProcess || company.dlEmail || company.accountQuirks || company.processNotes) && (
                <div className="border-t pt-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Account Intelligence</p>
                  <div className="space-y-3">
                    {company.tenderStyle && (
                      <div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><TruckIcon className="h-3 w-3" /> Tendering Process</p>
                        <p className="text-sm" data-testid="text-tender-style">{company.tenderStyle}</p>
                      </div>
                    )}
                    {company.spotProcess && (
                      <div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><Zap className="h-3 w-3" /> Spot Process</p>
                        <p className="text-sm" data-testid="text-spot-process">{company.spotProcess}</p>
                      </div>
                    )}
                    {company.dlEmail && (
                      <div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><Mail className="h-3 w-3" /> D/L Email</p>
                        <a href={`mailto:${company.dlEmail}`} className="text-sm text-blue-600 dark:text-blue-400 hover:underline" data-testid="text-dl-email">{company.dlEmail}</a>
                      </div>
                    )}
                    {company.accountQuirks && (
                      <div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><AlertCircle className="h-3 w-3" /> Account Quirks</p>
                        <p className="text-sm whitespace-pre-wrap" data-testid="text-account-quirks">{company.accountQuirks}</p>
                      </div>
                    )}
                    {company.processNotes && (
                      <div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1"><FileText className="h-3 w-3" /> Process Notes</p>
                        <p className="text-sm whitespace-pre-wrap" data-testid="text-process-notes">{company.processNotes}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Empty state nudge for intelligence section */}
              {!company.tenderStyle && !company.spotProcess && !company.dlEmail && !company.accountQuirks && !company.processNotes && (
                <div className="border-t pt-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Account Intelligence</p>
                  <p className="text-xs text-muted-foreground italic">No account intelligence captured yet. Click Edit to add tendering process, spot process, D/L email, quirks, and process notes.</p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Customer Scorecard */}
      <Card data-testid="card-customer-scorecard">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-primary" />
              Customer Scorecard
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          <p className="text-xs text-muted-foreground">
            Upload scorecards, performance reviews, or any account-related documents.
          </p>
          <FileAttachmentList
            entityType="scorecard"
            entityIds={companyId ? [companyId] : []}
            showForEntityId={companyId}
          />
          <div className="space-y-2">
            <FileAttachmentUpload
              pendingFiles={scorecardPending}
              onAdd={(files) => setScorecardPending(prev => [...prev, ...files])}
              onRemove={(i) => setScorecardPending(prev => prev.filter((_, idx) => idx !== i))}
            />
            {scorecardPending.length > 0 && (
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={scorecardUploading}
                data-testid="button-upload-scorecard"
                onClick={async () => {
                  if (!companyId) return;
                  setScorecardUploading(true);
                  try {
                    await uploadPendingFiles(scorecardPending, "scorecard", companyId);
                    setScorecardPending([]);
                    queryClient.invalidateQueries({ queryKey: ["/api/attachments", "scorecard", companyId] });
                    toast({ title: "Scorecard uploaded" });
                  } catch {
                    toast({ title: "Upload failed", variant: "destructive" });
                  } finally {
                    setScorecardUploading(false);
                  }
                }}
              >
                {scorecardUploading ? "Uploading…" : `Save ${scorecardPending.length} file${scorecardPending.length !== 1 ? "s" : ""}`}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Market Share */}
      <MarketShareCard companyId={companyId} rfps={companyRfps} />

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
                      {(task.commentCount ?? 0) > 0 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingTaskItem(task); setForceLanePrefill(undefined); setFocusTaskComments(true); setTaskDialogOpen(true); }}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary shrink-0 transition-colors"
                          title="View collaboration notes"
                          data-testid={`badge-task-comments-${task.id}`}
                        >
                          <MessageSquare className="h-3 w-3" />
                          {task.commentCount}
                        </button>
                      )}
                      <button onClick={() => { setEditingTaskItem(task); setForceLanePrefill(undefined); setFocusTaskComments(false); setTaskDialogOpen(true); }} className="shrink-0 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity text-xs" data-testid={`button-edit-company-task-${task.id}`}>Edit</button>
                      <button onClick={() => deleteTaskMutation.mutate(task.id)} className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" data-testid={`button-delete-company-task-${task.id}`}><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  );
                })}
            </div>
          ) : (
            <div className="text-center py-4 text-muted-foreground">
              <ClipboardList className="h-6 w-6 mx-auto mb-1 opacity-50" />
              <p className="text-xs mb-2">No tasks yet</p>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs h-7"
                onClick={() => { setEditingTaskItem(undefined); setForceLanePrefill(undefined); setFocusTaskComments(false); setTaskDialogOpen(true); }}
                data-testid="button-create-first-company-task"
              >
                <Plus className="h-3 w-3" /> Add a task
              </Button>
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

      {companyTouchpoints.length > 0 && (() => {
        const now = new Date();
        const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
        const monthTps = companyTouchpoints.filter(tp => tp.date >= monthStart);
        const uniqueContacts = new Set(monthTps.map(tp => tp.contactId)).size;
        const recentTps = [...companyTouchpoints].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
        const TYPE_LABELS: Record<string, string> = { call: "Call", email: "Email", text: "Text", site_visit: "Site Visit" };
        const TYPE_COLORS: Record<string, string> = {
          call:       "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
          email:      "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
          text:       "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
          site_visit: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
        };
        return (
          <Card data-testid="card-touchpoints-summary">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <PhoneCall className="h-4 w-4 text-cyan-500" />
                Touchpoints
                <Badge variant="secondary" className="ml-1 font-normal">{monthTps.length} this month · {uniqueContacts} contacts</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-1">
              {recentTps.map(tp => {
                const dateStr = (() => {
                  try { return new Date(tp.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
                  catch { return tp.date; }
                })();
                const cnt = contacts?.find(c => c.id === tp.contactId);
                return (
                  <div
                    key={tp.id}
                    className="flex items-center gap-2 py-1.5 cursor-pointer hover:bg-muted/40 rounded px-1"
                    onClick={() => cnt && setViewContact(cnt)}
                    data-testid={`tp-row-${tp.id}`}
                  >
                    <span className={`inline-flex text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${TYPE_COLORS[tp.type] ?? "bg-muted text-muted-foreground"}`}>
                      {TYPE_LABELS[tp.type] ?? tp.type}
                    </span>
                    <span className="text-sm truncate">{cnt?.name ?? "Unknown"}</span>
                    <span className="text-xs text-muted-foreground ml-auto shrink-0">{dateStr}</span>
                    {tp.notes && <span className="text-xs text-muted-foreground truncate max-w-[120px]">· {tp.notes}</span>}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        );
      })()}

      {activityItems.length > 0 && (
        <Card data-testid="card-activity-timeline">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Clock className="h-4 w-4 text-violet-500" />
              Account Activity
              <Badge variant="secondary" className="ml-1 font-normal">{activityItems.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="relative space-y-0">
              {activityItems.slice(0, 10).map((item, i) => {
                const iconColor =
                  item.type === "task_completed" ? "bg-green-500" :
                  item.type === "task_created" ? "bg-blue-500" :
                  item.type === "callout" ? "bg-orange-500" :
                  item.type === "rfp" ? "bg-violet-500" : "bg-muted-foreground";
                const dateStr = (() => {
                  try {
                    const d = new Date(item.date);
                    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
                  } catch { return item.date; }
                })();
                return (
                  <div key={i} className="flex gap-3 pb-4 relative" data-testid={`activity-item-${i}`}>
                    <div className="flex flex-col items-center">
                      <div className={`h-2 w-2 rounded-full mt-1.5 shrink-0 ${iconColor}`} />
                      {i < activityItems.slice(0, 10).length - 1 && (
                        <div className="w-px flex-1 bg-border mt-1" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 pb-1">
                      <p className="text-sm font-medium leading-tight">{item.title}</p>
                      {item.description && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{item.description}</p>}
                      <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                        <span>{dateStr}</span>
                        {item.userName && <><span>·</span><span>{item.userName}</span></>}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
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
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setImportDialogOpen(true)} data-testid="button-import-contacts">
                <Upload className="h-4 w-4 mr-1.5" />
                Import
              </Button>
              <Button onClick={handleAddContact} data-testid="button-add-contact-top">
                <Plus className="h-4 w-4 mr-2" />
                Add Contact
              </Button>
            </div>
          </div>
          {contacts && contacts.length > 0 ? (
            <OrgChart
              contacts={contacts}
              touchpoints={companyTouchpoints}
              onEditContact={handleEditContact}
              onViewContact={setViewContact}
              onLogTouch={(c) => { setQuickTouchContactId(c.id); setQuickTouchOpen(true); }}
            />
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

      {/* ── RFP Intelligence (unified: Coverage + Lane Patterns + Lane Matching) ── */}
      {(facilityCoverage !== undefined || lanePatterns !== undefined || laneMatching !== undefined) && (() => {
        const gapCount = facilityCoverage?.summary.gaps ?? 0;
        const closeMatchCount =
          (laneMatching?.ourDeliveriesToTheirPickups.filter(m => m.distance < 10).length ?? 0) +
          (laneMatching?.theirDeliveriesToOurPickups.filter(m => m.distance < 10).length ?? 0);
        const matchCount = (laneMatching?.ourDeliveriesToTheirPickups.length ?? 0) + (laneMatching?.theirDeliveriesToOurPickups.length ?? 0);
        const corridorCount = lanePatterns?.topCorridors.filter(c => {
          const v = (s: string) => !!s && s.trim().toUpperCase() !== "N/A" && s.trim() !== "";
          return (v(c.origin) || v(c.originState)) && (v(c.destination) || v(c.destinationState));
        }).length ?? 0;
        const hasAnyData =
          (facilityCoverage?.facilities.length ?? 0) > 0 ||
          (lanePatterns && (lanePatterns.topCorridors.length > 0 || lanePatterns.hubs.length > 0 || lanePatterns.stateCorridors.length > 0)) ||
          (laneMatching?.hasRfpData);
        const validLoc = (s: string) => !!s && s.trim().toUpperCase() !== "N/A" && s.trim() !== "";
        const hubCoverage = (hubName: string) =>
          facilityCoverage?.facilities.find(f => f.fullName === hubName && f.covered) ?? null;

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
              <Tabs defaultValue="coverage" className="w-full">
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
                                    <p className="text-xs text-muted-foreground">{f.totalVolume.toLocaleString()} loads/yr{f.coveredBy ? ` · ${f.coveredBy}` : ""}</p>
                                  </div>
                                </div>
                                <Badge className="bg-green-500/10 text-green-600 dark:text-green-400 shrink-0"><CheckCircle className="h-3 w-3 mr-1" />Covered</Badge>
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
                  ) : (
                  <Tabs defaultValue="corridors" className="w-full">
                    <TabsList className="w-full grid grid-cols-3 mb-3">
                      <TabsTrigger value="corridors" data-testid="tab-top-corridors">
                        <ArrowRightLeft className="h-3.5 w-3.5 mr-1.5" />Top Corridors
                      </TabsTrigger>
                      <TabsTrigger value="hubs" data-testid="tab-hubs">
                        <Warehouse className="h-3.5 w-3.5 mr-1.5" />Hubs
                      </TabsTrigger>
                      <TabsTrigger value="states" data-testid="tab-state-corridors">
                        <Repeat2 className="h-3.5 w-3.5 mr-1.5" />State Map
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value="corridors" className="mt-0">
                      {(() => {
                        const filteredCorridors = lanePatterns.topCorridors.filter(c =>
                          (validLoc(c.origin) || validLoc(c.originState)) && (validLoc(c.destination) || validLoc(c.destinationState))
                        );
                        const activeCorridors = filteredCorridors.filter(c => !vendorRoutedKeys.includes(`corridor:${c.lane}`));
                        const handledCorridors = filteredCorridors.filter(c => vendorRoutedKeys.includes(`corridor:${c.lane}`));
                        const multiRfpCount = filteredCorridors.filter(c => c.appearsInMultipleRfps).length;
                        return filteredCorridors.length > 0 ? (
                          <div className="space-y-3">
                            {multiRfpCount > 0 && (
                              <div className="flex items-center gap-2 rounded-md px-3 py-2 bg-blue-50/60 dark:bg-blue-950/20 border border-blue-200/50 dark:border-blue-800/30 text-xs">
                                <ArrowRightLeft className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                                <span><span className="font-medium text-blue-700 dark:text-blue-300">{multiRfpCount} corridor{multiRfpCount !== 1 ? "s" : ""}</span> appear in 2+ RFPs — highest priority for outreach.</span>
                              </div>
                            )}
                            <div className="space-y-2">
                              {activeCorridors.map((c, i) => (
                                <div key={i} className={`flex items-center justify-between p-3 rounded-md border bg-background hover:bg-muted/50 transition-colors ${c.appearsInMultipleRfps ? "border-blue-200 dark:border-blue-800/50" : ""}`} data-testid={`corridor-${i}`}>
                                  <div className="flex items-center gap-3 min-w-0 flex-1">
                                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 shrink-0">
                                      <TruckIcon className="h-3.5 w-3.5" />
                                    </div>
                                    <div className="min-w-0">
                                      <p className="font-medium text-sm truncate">{c.lane}</p>
                                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 flex-wrap">
                                        <span>{c.totalVolume.toLocaleString()} loads/yr</span>
                                        {c.originState && c.destinationState && <span className="font-mono text-[11px] bg-muted px-1.5 py-0.5 rounded">{c.originState} → {c.destinationState}</span>}
                                        {c.count > 1 && <span className="text-blue-600 dark:text-blue-400 font-medium">×{c.count}</span>}
                                        {c.appearsInMultipleRfps && <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400 text-[10px] px-1.5 py-0">Multi-RFP</Badge>}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-1.5 shrink-0 ml-2">
                                    <span className="text-xs text-muted-foreground font-mono hidden sm:block">{c.rfpTitles.join(", ")}</span>
                                    {canReassign && (
                                      <Button size="sm" variant="outline" className="border-indigo-300 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:text-indigo-400 h-7 px-2 text-xs"
                                        onClick={() => openForceTask(`Corridor: ${c.lane}`, `Lane Pattern — Top Corridor\nLane: ${c.lane}\nVolume: ${c.totalVolume.toLocaleString()} loads/yr\nAppearances: ${c.count}x\nRFPs: ${c.rfpTitles.join(", ")}${c.appearsInMultipleRfps ? "\nAppears in multiple RFPs" : ""}`)}
                                        data-testid={`button-force-task-corridor-${i}`}>
                                        <Zap className="h-3 w-3 mr-1" />Task
                                      </Button>
                                    )}
                                    <Button size="sm" variant="outline" disabled={vendorRoutedToggle.isPending}
                                      className={vendorRoutedKeys.includes(`corridor:${c.lane}`) ? "bg-green-500 text-white border-green-500 hover:bg-green-600 h-7 px-2 text-xs" : "border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 h-7 px-2 text-xs"}
                                      onClick={() => vendorRoutedToggle.mutate(`corridor:${c.lane}`)}
                                      data-testid={`button-vendor-routed-corridor-${i}`}>
                                      <TruckIcon className="h-3 w-3 mr-1" />Handled
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                            {handledCorridors.length > 0 && (
                              <details className="group">
                                <summary className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer list-none hover:text-foreground">
                                  <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                                  Vendor Routed ({handledCorridors.length})
                                </summary>
                                <div className="mt-2 space-y-1 opacity-60">
                                  {handledCorridors.map((c, i) => (
                                    <div key={i} className="flex items-center justify-between p-2 rounded-md border text-xs">
                                      <span>{c.lane}</span>
                                      <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]" onClick={() => vendorRoutedToggle.mutate(`corridor:${c.lane}`)}>Undo</Button>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            )}
                          </div>
                        ) : <p className="text-sm text-muted-foreground text-center py-6">No corridor data available</p>;
                      })()}
                    </TabsContent>

                    <TabsContent value="hubs" className="mt-0">
                      {(() => {
                        const filteredHubs = lanePatterns.hubs.filter(h => validLoc(h.facility) || validLoc(h.state));
                        const activeHubs = filteredHubs.filter(h => !vendorRoutedKeys.includes(`hub:${h.fullName}`));
                        const handledHubs = filteredHubs.filter(h => vendorRoutedKeys.includes(`hub:${h.fullName}`));
                        const hubGapCount = filteredHubs.filter(h => !hubCoverage(h.fullName)).length;
                        return filteredHubs.length > 0 ? (
                          <div className="space-y-3">
                            <p className="text-xs text-muted-foreground">High-traffic facilities appearing as both origins and destinations — likely managed by dedicated planners.</p>
                            {hubGapCount > 0 ? (
                              <div className="flex items-center gap-2 rounded-md px-3 py-2 bg-red-50/60 dark:bg-red-950/20 border border-red-200/50 dark:border-red-800/30 text-xs">
                                <ShieldAlert className="h-3.5 w-3.5 text-red-600 dark:text-red-400 shrink-0" />
                                <span><span className="font-medium text-red-700 dark:text-red-300">{hubGapCount} of {filteredHubs.length} hub{filteredHubs.length !== 1 ? "s" : ""}</span> {hubGapCount === 1 ? "is" : "are"} missing a contact — find a planner for each gap.</span>
                              </div>
                            ) : filteredHubs.length > 0 ? (
                              <div className="flex items-center gap-2 rounded-md px-3 py-2 bg-green-50/60 dark:bg-green-950/20 border border-green-200/50 dark:border-green-800/30 text-xs">
                                <CheckCircle className="h-3.5 w-3.5 text-green-600 dark:text-green-400 shrink-0" />
                                <span className="text-green-700 dark:text-green-300 font-medium">All {filteredHubs.length} hubs have a contact assigned.</span>
                              </div>
                            ) : null}
                            <div className="space-y-2">
                              {activeHubs.map((h, i) => {
                                const coverageContact = hubCoverage(h.fullName);
                                return (
                                  <div key={i} className="flex items-center justify-between p-3 rounded-md border bg-background hover:bg-muted/50 transition-colors" data-testid={`hub-${i}`}>
                                    <div className="flex items-center gap-3 min-w-0 flex-1">
                                      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 shrink-0">
                                        <Warehouse className="h-3.5 w-3.5" />
                                      </div>
                                      <div className="min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <p className="font-medium text-sm">{h.fullName}</p>
                                          {coverageContact ? (
                                            <Badge className="bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400 text-[10px] px-1.5 py-0">
                                              <CheckCircle className="h-2.5 w-2.5 mr-0.5" />Covered
                                            </Badge>
                                          ) : (
                                            <Badge className="bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400 text-[10px] px-1.5 py-0">
                                              <ShieldAlert className="h-2.5 w-2.5 mr-0.5" />Gap
                                            </Badge>
                                          )}
                                        </div>
                                        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                                          <span>{h.totalVolume.toLocaleString()} loads/yr</span>
                                          <span className="flex items-center gap-0.5 text-green-600 dark:text-green-400"><ArrowUpFromLine className="h-2.5 w-2.5" />{h.outboundVolume.toLocaleString()}</span>
                                          <span className="flex items-center gap-0.5 text-blue-600 dark:text-blue-400"><ArrowDownToLine className="h-2.5 w-2.5" />{h.inboundVolume.toLocaleString()}</span>
                                        </div>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                      {canReassign && (
                                        <Button size="sm" variant="outline" className="border-indigo-300 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:text-indigo-400 h-7 px-2 text-xs"
                                          onClick={() => openForceTask(`Hub: ${h.fullName}`, `Lane Pattern — Shipping/Receiving Hub\nFacility: ${h.fullName}\nTotal Volume: ${h.totalVolume.toLocaleString()} loads/yr\nOutbound: ${h.outboundVolume.toLocaleString()} (${h.outboundCount} lanes)\nInbound: ${h.inboundVolume.toLocaleString()} (${h.inboundCount} lanes)`)}
                                          data-testid={`button-force-task-hub-${i}`}>
                                          <Zap className="h-3 w-3 mr-1" />Task
                                        </Button>
                                      )}
                                      <Button size="sm" variant="outline" disabled={vendorRoutedToggle.isPending}
                                        className={vendorRoutedKeys.includes(`hub:${h.fullName}`) ? "bg-green-500 text-white border-green-500 hover:bg-green-600 h-7 px-2 text-xs" : "border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 h-7 px-2 text-xs"}
                                        onClick={() => vendorRoutedToggle.mutate(`hub:${h.fullName}`)}
                                        data-testid={`button-vendor-routed-hub-${i}`}>
                                        <TruckIcon className="h-3 w-3 mr-1" />Handled
                                      </Button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            {handledHubs.length > 0 && (
                              <details className="group">
                                <summary className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer list-none hover:text-foreground">
                                  <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                                  Vendor Routed ({handledHubs.length})
                                </summary>
                                <div className="mt-2 space-y-1 opacity-60">
                                  {handledHubs.map((h, i) => (
                                    <div key={i} className="flex items-center justify-between p-2 rounded-md border text-xs">
                                      <span>{h.fullName}</span>
                                      <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]" onClick={() => vendorRoutedToggle.mutate(`hub:${h.fullName}`)}>Undo</Button>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            )}
                          </div>
                        ) : <p className="text-sm text-muted-foreground text-center py-6">No facilities appear as both origins and destinations</p>;
                      })()}
                    </TabsContent>

                    <TabsContent value="states" className="mt-0">
                      {(() => {
                        const filteredStates = lanePatterns.stateCorridors.filter(s => validLoc(s.originState) && validLoc(s.destinationState));
                        const activeStates = filteredStates.filter(s => !vendorRoutedKeys.includes(`state-corridor:${s.corridor}`));
                        const handledStates = filteredStates.filter(s => vendorRoutedKeys.includes(`state-corridor:${s.corridor}`));
                        const topState = filteredStates[0];
                        return filteredStates.length > 0 ? (
                          <div className="space-y-3">
                            {topState && (
                              <div className="flex items-center gap-2 rounded-md px-3 py-2 bg-muted/40 border text-xs">
                                <Repeat2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                <span className="text-muted-foreground">{filteredStates.length} state corridor{filteredStates.length !== 1 ? "s" : ""} · Highest volume: <span className="font-medium text-foreground">{topState.corridor}</span> at {topState.totalVolume.toLocaleString()} loads/yr</span>
                              </div>
                            )}
                            <div className="overflow-x-auto rounded-md border">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="bg-muted/50 border-b">
                                    <th className="text-left font-medium px-3 py-2">Corridor</th>
                                    <th className="text-right font-medium px-3 py-2">Lanes</th>
                                    <th className="text-right font-medium px-3 py-2">Volume</th>
                                    <th className="text-left px-3 py-2 w-1/3">Share</th>
                                    {canReassign && <th className="text-right font-medium px-3 py-2"></th>}
                                    <th className="text-right font-medium px-3 py-2"></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(() => {
                                    const maxVol = Math.max(...filteredStates.map(s => s.totalVolume));
                                    return activeStates.map((s, i) => (
                                      <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors" data-testid={`state-corridor-${i}`}>
                                        <td className="px-3 py-2 font-medium">{s.corridor}</td>
                                        <td className="px-3 py-2 text-right text-muted-foreground">{s.laneCount}</td>
                                        <td className="px-3 py-2 text-right font-medium">{s.totalVolume.toLocaleString()}</td>
                                        <td className="px-3 py-2">
                                          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                                            <div className="h-full bg-gradient-to-r from-blue-500 to-green-500 rounded-full transition-all" style={{ width: `${(s.totalVolume / maxVol) * 100}%` }} />
                                          </div>
                                        </td>
                                        {canReassign && (
                                          <td className="px-3 py-2 text-right">
                                            <Button size="sm" variant="outline" className="border-indigo-300 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:text-indigo-400 h-7 px-2 text-xs"
                                              onClick={() => openForceTask(`State Corridor: ${s.corridor}`, `Lane Pattern — State Corridor\nCorridor: ${s.corridor}\nLanes: ${s.laneCount}\nVolume: ${s.totalVolume.toLocaleString()} loads/yr`)}
                                              data-testid={`button-force-task-state-corridor-${i}`}>
                                              <Zap className="h-3 w-3 mr-1" />Task
                                            </Button>
                                          </td>
                                        )}
                                        <td className="px-3 py-2 text-right">
                                          <Button size="sm" variant="outline" disabled={vendorRoutedToggle.isPending}
                                            className={vendorRoutedKeys.includes(`state-corridor:${s.corridor}`) ? "bg-green-500 text-white border-green-500 hover:bg-green-600 h-7 px-2 text-xs" : "border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 h-7 px-2 text-xs"}
                                            onClick={() => vendorRoutedToggle.mutate(`state-corridor:${s.corridor}`)}
                                            data-testid={`button-vendor-routed-state-corridor-${i}`}>
                                            <TruckIcon className="h-3 w-3 mr-1" />Handled
                                          </Button>
                                        </td>
                                      </tr>
                                    ));
                                  })()}
                                </tbody>
                              </table>
                            </div>
                            {handledStates.length > 0 && (
                              <details className="group">
                                <summary className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer list-none hover:text-foreground">
                                  <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                                  Vendor Routed ({handledStates.length})
                                </summary>
                                <div className="mt-2 space-y-1 opacity-60">
                                  {handledStates.map((s, i) => (
                                    <div key={i} className="flex items-center justify-between p-2 rounded-md border text-xs">
                                      <span>{s.corridor}</span>
                                      <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]" onClick={() => vendorRoutedToggle.mutate(`state-corridor:${s.corridor}`)}>Undo</Button>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            )}
                          </div>
                        ) : <p className="text-sm text-muted-foreground text-center py-6">No state corridor data available</p>;
                      })()}
                    </TabsContent>
                  </Tabs>
                  )}
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
                  ) : (
                    <div className="space-y-5">
                      {/* Section 1: Our Deliveries → Their Pickups */}
                      {(() => {
                        const mkDeliveryKey = (m: { ourCity: string; ourState: string; customerCity: string; customerState: string }) =>
                          `match-delivery:${m.ourCity},${m.ourState}:${m.customerCity},${m.customerState}`;
                        const activeDeliveries = laneMatching.ourDeliveriesToTheirPickups.filter(m => !vendorRoutedKeys.includes(mkDeliveryKey(m)));
                        const handledDeliveries = laneMatching.ourDeliveriesToTheirPickups.filter(m => vendorRoutedKeys.includes(mkDeliveryKey(m)));
                        return (
                          <div>
                            <div className="flex items-center gap-2 mb-1.5">
                              <ArrowDownToLine className="h-4 w-4 text-blue-500" />
                              <p className="text-sm font-semibold text-blue-700 dark:text-blue-300">Our Trucks Near Their Pickup Zones</p>
                              {activeDeliveries.length > 0 && <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400 text-[10px]">{activeDeliveries.length}</Badge>}
                            </div>
                            <p className="text-xs text-muted-foreground mb-3">We already drop freight in these areas. We can pick up their loads on the way back — incremental revenue with trucks already in position.</p>
                            {activeDeliveries.length === 0 && handledDeliveries.length === 0 ? (
                              <p className="text-sm text-muted-foreground text-center py-4">No matches within 50 miles.</p>
                            ) : (
                              <div className="space-y-2">
                                {activeDeliveries.slice(0, 20).map((m, i) => {
                                  const key = mkDeliveryKey(m);
                                  const isExpanded = expandedDeliveries.has(i);
                                  const visibleLanes = isExpanded ? m.matchingLanes : m.matchingLanes.slice(0, 3);
                                  const hiddenCount = m.matchingLanes.length - 3;
                                  const distClass = m.distance === 0 || m.distance < 10 ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300" : m.distance < 25 ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" : "bg-muted text-muted-foreground";
                                  return (
                                    <div key={i} className="rounded-lg border overflow-hidden" data-testid={`match-delivery-${i}`}>
                                      <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-muted/20">
                                        <div className="text-sm font-semibold truncate flex items-center gap-1.5">
                                          <span className="text-blue-600 dark:text-blue-400">{m.ourCity}, {m.ourState}</span>
                                          <ArrowRightLeft className="h-3 w-3 text-muted-foreground shrink-0" />
                                          <span>{m.customerCity}, {m.customerState}</span>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${distClass}`}>{m.distance === 0 ? "Exact" : `${m.distance} mi`}</span>
                                          <span className="text-xs text-muted-foreground whitespace-nowrap">{m.ourWeeklyLoads}/wk · {m.totalVolume.toLocaleString()} vol</span>
                                          {canReassign && (
                                            <Button size="sm" variant="outline" className="border-indigo-300 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:text-indigo-400 h-6 px-2 text-xs"
                                              onClick={() => openForceTask(`Lane Match: ${m.ourCity}, ${m.ourState} ↔ ${m.customerCity}, ${m.customerState}`, `Lane Matching — Our Deliveries → Their Pickups\nWe Deliver To: ${m.ourCity}, ${m.ourState}\nCustomer Pickup: ${m.customerCity}, ${m.customerState}\nDistance: ${m.distance} mi\nOur Frequency: ${m.ourWeeklyLoads}/wk\nCustomer Volume: ${m.totalVolume.toLocaleString()} loads/yr\nMatching Lanes:\n${m.matchingLanes.map(l => `  • ${l.lane} (${l.volume} vol) — ${l.rfpTitle}`).join("\n")}`)}
                                              data-testid={`button-force-task-match-delivery-${i}`}>
                                              <Zap className="h-3 w-3 mr-1" />Task
                                            </Button>
                                          )}
                                          <Button size="sm" variant="outline" disabled={vendorRoutedToggle.isPending}
                                            className={vendorRoutedKeys.includes(key) ? "bg-green-500 text-white border-green-500 hover:bg-green-600 h-6 px-2 text-xs" : "border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 h-6 px-2 text-xs"}
                                            onClick={() => vendorRoutedToggle.mutate(key)}
                                            data-testid={`button-handled-match-delivery-${i}`}>
                                            <TruckIcon className="h-3 w-3 mr-1" />Handled
                                          </Button>
                                        </div>
                                      </div>
                                      <div className="divide-y">
                                        {visibleLanes.map((l, li) => (
                                          <div key={li} className="flex items-center justify-between px-3 py-1.5 text-xs hover:bg-muted/30">
                                            <span className="text-muted-foreground truncate">{l.lane}</span>
                                            <span className="shrink-0 ml-2 text-muted-foreground">{l.volume.toLocaleString()} vol</span>
                                          </div>
                                        ))}
                                        {m.matchingLanes.length > 3 && (
                                          <button onClick={() => toggleExpanded(expandedDeliveries, i, setExpandedDeliveries)} className="w-full px-3 py-1.5 text-xs text-primary hover:bg-muted/30 text-left">
                                            {isExpanded ? "▲ Show less" : `▼ Show ${hiddenCount} more lane${hiddenCount !== 1 ? "s" : ""}`}
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                                {activeDeliveries.length > 20 && <p className="text-xs text-muted-foreground text-center pt-1">+{activeDeliveries.length - 20} more location pairs</p>}
                                {handledDeliveries.length > 0 && (
                                  <details className="group">
                                    <summary className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer list-none hover:text-foreground">
                                      <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                                      Handled ({handledDeliveries.length})
                                    </summary>
                                    <div className="mt-2 space-y-1 opacity-60">
                                      {handledDeliveries.map((m, i) => (
                                        <div key={i} className="flex items-center justify-between p-2 rounded-md border text-xs">
                                          <span>{m.ourCity}, {m.ourState} ↔ {m.customerCity}, {m.customerState}</span>
                                          <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]" onClick={() => vendorRoutedToggle.mutate(mkDeliveryKey(m))}>Undo</Button>
                                        </div>
                                      ))}
                                    </div>
                                  </details>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* Section 2: Their Deliveries → Our Pickups */}
                      {(() => {
                        const mkPickupKey = (m: { customerCity: string; customerState: string; ourCity: string; ourState: string }) =>
                          `match-pickup:${m.customerCity},${m.customerState}:${m.ourCity},${m.ourState}`;
                        const activePickups = laneMatching.theirDeliveriesToOurPickups.filter(m => !vendorRoutedKeys.includes(mkPickupKey(m)));
                        const handledPickups = laneMatching.theirDeliveriesToOurPickups.filter(m => vendorRoutedKeys.includes(mkPickupKey(m)));
                        return (
                          <div className="border-t pt-4">
                            <div className="flex items-center gap-2 mb-1.5">
                              <ArrowUpFromLine className="h-4 w-4 text-green-500" />
                              <p className="text-sm font-semibold text-green-700 dark:text-green-300">Their Destinations Near Our Pickup Zones</p>
                              {activePickups.length > 0 && <Badge className="bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400 text-[10px]">{activePickups.length}</Badge>}
                            </div>
                            <p className="text-xs text-muted-foreground mb-3">They need deliveries near where we already pick up freight — potential backhaul loads that fill our existing return trips.</p>
                            {activePickups.length === 0 && handledPickups.length === 0 ? (
                              <p className="text-sm text-muted-foreground text-center py-4">No matches within 50 miles.</p>
                            ) : (
                              <div className="space-y-2">
                                {activePickups.slice(0, 20).map((m, i) => {
                                  const key = mkPickupKey(m);
                                  const isExpanded = expandedPickups.has(i);
                                  const visibleLanes = isExpanded ? m.matchingLanes : m.matchingLanes.slice(0, 3);
                                  const hiddenCount = m.matchingLanes.length - 3;
                                  const distClass = m.distance === 0 || m.distance < 10 ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300" : m.distance < 25 ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" : "bg-muted text-muted-foreground";
                                  return (
                                    <div key={i} className="rounded-lg border overflow-hidden" data-testid={`match-pickup-${i}`}>
                                      <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-muted/20">
                                        <div className="text-sm font-semibold truncate flex items-center gap-1.5">
                                          <span>{m.customerCity}, {m.customerState}</span>
                                          <ArrowRightLeft className="h-3 w-3 text-muted-foreground shrink-0" />
                                          <span className="text-blue-600 dark:text-blue-400">{m.ourCity}, {m.ourState}</span>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${distClass}`}>{m.distance === 0 ? "Exact" : `${m.distance} mi`}</span>
                                          <span className="text-xs text-muted-foreground whitespace-nowrap">{m.ourWeeklyLoads}/wk · {m.totalVolume.toLocaleString()} vol</span>
                                          {canReassign && (
                                            <Button size="sm" variant="outline" className="border-indigo-300 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:text-indigo-400 h-6 px-2 text-xs"
                                              onClick={() => openForceTask(`Lane Match: ${m.customerCity}, ${m.customerState} ↔ ${m.ourCity}, ${m.ourState}`, `Lane Matching — Their Deliveries → Our Pickups\nCustomer Delivers To: ${m.customerCity}, ${m.customerState}\nWe Pick Up At: ${m.ourCity}, ${m.ourState}\nDistance: ${m.distance} mi\nOur Frequency: ${m.ourWeeklyLoads}/wk\nCustomer Volume: ${m.totalVolume.toLocaleString()} loads/yr\nMatching Lanes:\n${m.matchingLanes.map(l => `  • ${l.lane} (${l.volume} vol) — ${l.rfpTitle}`).join("\n")}`)}
                                              data-testid={`button-force-task-match-pickup-${i}`}>
                                              <Zap className="h-3 w-3 mr-1" />Task
                                            </Button>
                                          )}
                                          <Button size="sm" variant="outline" disabled={vendorRoutedToggle.isPending}
                                            className={vendorRoutedKeys.includes(key) ? "bg-green-500 text-white border-green-500 hover:bg-green-600 h-6 px-2 text-xs" : "border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 h-6 px-2 text-xs"}
                                            onClick={() => vendorRoutedToggle.mutate(key)}
                                            data-testid={`button-handled-match-pickup-${i}`}>
                                            <TruckIcon className="h-3 w-3 mr-1" />Handled
                                          </Button>
                                        </div>
                                      </div>
                                      <div className="divide-y">
                                        {visibleLanes.map((l, li) => (
                                          <div key={li} className="flex items-center justify-between px-3 py-1.5 text-xs hover:bg-muted/30">
                                            <span className="text-muted-foreground truncate">{l.lane}</span>
                                            <span className="shrink-0 ml-2 text-muted-foreground">{l.volume.toLocaleString()} vol</span>
                                          </div>
                                        ))}
                                        {m.matchingLanes.length > 3 && (
                                          <button onClick={() => toggleExpanded(expandedPickups, i, setExpandedPickups)} className="w-full px-3 py-1.5 text-xs text-primary hover:bg-muted/30 text-left">
                                            {isExpanded ? "▲ Show less" : `▼ Show ${hiddenCount} more lane${hiddenCount !== 1 ? "s" : ""}`}
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                                {activePickups.length > 20 && <p className="text-xs text-muted-foreground text-center pt-1">+{activePickups.length - 20} more location pairs</p>}
                                {handledPickups.length > 0 && (
                                  <details className="group">
                                    <summary className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer list-none hover:text-foreground">
                                      <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                                      Handled ({handledPickups.length})
                                    </summary>
                                    <div className="mt-2 space-y-1 opacity-60">
                                      {handledPickups.map((m, i) => (
                                        <div key={i} className="flex items-center justify-between p-2 rounded-md border text-xs">
                                          <span>{m.customerCity}, {m.customerState} ↔ {m.ourCity}, {m.ourState}</span>
                                          <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]" onClick={() => vendorRoutedToggle.mutate(mkPickupKey(m))}>Undo</Button>
                                        </div>
                                      ))}
                                    </div>
                                  </details>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            )}
          </CardContent>
          )}
        </Card>
        );
      })()}

      {researchTasks && researchTasks.length > 0 && (() => {
        const hasLocation = (city: string, state: string) => {
          const valid = (s: string) => !!s && s.trim().toUpperCase() !== "N/A" && s.trim() !== "";
          return valid(city) || valid(state);
        };
        const unresolvedTasks = researchTasks.filter((t) =>
          (t.status === "open" || t.status === "contact_added") &&
          hasLocation(t.origin, t.originState) &&
          hasLocation(t.destination, t.destinationState)
        );
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

      <Dialog open={importDialogOpen} onOpenChange={(open) => { setImportDialogOpen(open); if (!open) { setImportRows([]); setImportFileName(""); } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-green-600" />
              Import Contacts from Excel
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {importRows.length === 0 ? (
              <div className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center">
                <Upload className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-sm font-medium mb-1">Drop your spreadsheet here or click to browse</p>
                <p className="text-xs text-muted-foreground mb-4">Supports .xlsx, .xls, and .csv files. Columns detected automatically: Name, Title, Email, Phone, Notes.</p>
                <label className="cursor-pointer">
                  <Button variant="outline" size="sm" asChild>
                    <span><Upload className="h-4 w-4 mr-2" />Choose File</span>
                  </Button>
                  <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} data-testid="input-import-contacts-file" />
                </label>
                {importFileName && <p className="text-xs text-muted-foreground mt-2">{importFileName}</p>}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">{importRows.length} contacts found in <span className="font-medium text-foreground">{importFileName}</span></p>
                  <label className="cursor-pointer">
                    <Button variant="ghost" size="sm" asChild>
                      <span>Change file</span>
                    </Button>
                    <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} />
                  </label>
                </div>
                <div className="border rounded-md overflow-hidden">
                  <div className="overflow-x-auto max-h-64">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50 sticky top-0">
                        <tr>
                          {["Name", "Title", "Email", "Phone", "Notes"].map(h => (
                            <th key={h} className="text-left px-3 py-2 font-medium text-muted-foreground">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {importRows.slice(0, 20).map((r, i) => (
                          <tr key={i} className="border-t border-muted/50">
                            <td className="px-3 py-2 font-medium">{r.name}</td>
                            <td className="px-3 py-2 text-muted-foreground">{r.title || "—"}</td>
                            <td className="px-3 py-2 text-muted-foreground">{r.email || "—"}</td>
                            <td className="px-3 py-2 text-muted-foreground">{r.phone || "—"}</td>
                            <td className="px-3 py-2 text-muted-foreground truncate max-w-[150px]">{r.notes || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {importRows.length > 20 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground border-t bg-muted/30">+{importRows.length - 20} more rows not shown</div>
                  )}
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setImportDialogOpen(false); setImportRows([]); setImportFileName(""); }}>Cancel</Button>
            <Button onClick={() => bulkImportMutation.mutate(importRows)} disabled={importRows.length === 0 || bulkImportMutation.isPending} data-testid="button-confirm-import">
              {bulkImportMutation.isPending ? "Importing..." : `Import ${importRows.length > 0 ? importRows.length + " " : ""}Contact${importRows.length !== 1 ? "s" : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <ContactDetailSheet
        contact={viewContact}
        open={!!viewContact}
        onClose={() => setViewContact(null)}
        onEdit={(c) => { setViewContact(null); handleEditContact(c); }}
      />

      <Dialog open={quickTouchOpen} onOpenChange={open => { if (!open) { setQuickTouchOpen(false); setQuickTouchContactId(""); setQuickTouchType("call"); setQuickTouchNote(""); } }}>
        <DialogContent className="sm:max-w-sm" data-testid="dialog-quick-touch-detail">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PhoneCall className="h-4 w-4 text-primary" />
              Log Touch — {company.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Contact</label>
              <Select value={quickTouchContactId} onValueChange={setQuickTouchContactId}>
                <SelectTrigger data-testid="select-quick-touch-contact-detail">
                  <SelectValue placeholder="Pick a contact" />
                </SelectTrigger>
                <SelectContent>
                  {(contacts ?? []).map((c: Contact) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}{c.title ? ` · ${c.title}` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Touch Type</label>
              <div className="flex gap-2">
                {[{ value: "call", label: "Call" }, { value: "email", label: "Email" }, { value: "text", label: "Text" }, { value: "site_visit", label: "Site Visit" }].map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setQuickTouchType(opt.value)}
                    data-testid={`button-touch-type-detail-${opt.value}`}
                    className={`flex-1 py-1.5 text-xs rounded-md border transition-colors ${
                      quickTouchType === opt.value
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Notes <span className="font-normal">(optional)</span></label>
              <textarea
                value={quickTouchNote}
                onChange={e => setQuickTouchNote(e.target.value)}
                placeholder="What did you discuss? Any follow-ups?"
                rows={3}
                data-testid="textarea-quick-touch-note-detail"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
              />
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => { setQuickTouchOpen(false); setQuickTouchNote(""); }} data-testid="button-cancel-quick-touch-detail">Cancel</Button>
              <Button
                className="flex-1"
                disabled={!quickTouchContactId || logTouchFromDetailMutation.isPending}
                onClick={() => logTouchFromDetailMutation.mutate({ contactId: quickTouchContactId, type: quickTouchType, notes: quickTouchNote })}
                data-testid="button-submit-quick-touch-detail"
              >
                Log Touch
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Historical Trends Dialog */}
      <Dialog open={showTrends} onOpenChange={setShowTrends}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              Historical Freight Trends — {company?.name}
            </DialogTitle>
          </DialogHeader>

          {trendsLoading ? (
            <div className="py-12 text-center text-muted-foreground">Loading trends data…</div>
          ) : !trendsData || trendsData.totalLoads === 0 ? (
            <div className="py-12 text-center">
              <TrendingUp className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No freight history found for this account.</p>
              <p className="text-xs text-muted-foreground mt-1">Make sure a financial alias is set if the customer name differs in the uploaded data.</p>
              {trendAliasSuggestions.length > 0 && (
                <div className="mt-4 text-left max-w-sm mx-auto">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Possible matches in uploaded data:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {trendAliasSuggestions.map(name => (
                      <span key={name} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300">
                        {name}
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">Set one of these as the Financial Alias on the account page to link the data.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-6">
              {/* Summary KPIs */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: "Total Loads", value: trendsData.totalLoads.toLocaleString() },
                  { label: "Spot Loads", value: `${trendsData.spotLoads.toLocaleString()} (${trendsData.totalLoads > 0 ? Math.round((trendsData.spotLoads / trendsData.totalLoads) * 100) : 0}%)` },
                  { label: "Total Margin", value: `$${trendsData.totalMargin.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` },
                ].map(kpi => (
                  <div key={kpi.label} className="rounded-lg border bg-muted/40 px-4 py-3 text-center">
                    <div className="text-lg font-semibold">{kpi.value}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{kpi.label}</div>
                  </div>
                ))}
              </div>

              {/* Monthly Chart */}
              {trendsData.months.length > 1 && (
                <div>
                  <h3 className="text-sm font-semibold mb-3">Monthly Trend</h3>
                  <ResponsiveContainer width="100%" height={220}>
                    <ComposedChart data={[...trendsData.months].map(m => {
                      const [y, mo] = m.monthKey.split("-");
                      return {
                        month: new Date(parseInt(y), parseInt(mo) - 1, 1).toLocaleString("default", { month: "short", year: "2-digit" }),
                        loads: m.totalLoads,
                        spot: m.spotLoads,
                        margin: Math.round(m.totalMargin),
                      };
                    })} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis yAxisId="loads" tick={{ fontSize: 11 }} width={35} />
                      <YAxis yAxisId="margin" orientation="right" tick={{ fontSize: 11 }} width={55} tickFormatter={v => v >= 1000 ? `$${(v/1000).toFixed(0)}K` : `$${v}`} />
                      <RechartTooltip
                        contentStyle={{ fontSize: 12 }}
                        formatter={(value: number, name: string) => {
                          if (name === "margin") return [`$${value.toLocaleString()}`, "Margin"];
                          return [value, name === "loads" ? "Total Loads" : "Spot Loads"];
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar yAxisId="loads" dataKey="loads" fill="#3b82f6" name="Loads" radius={[2,2,0,0]} />
                      <Bar yAxisId="loads" dataKey="spot" fill="#f59e0b" name="Spot" radius={[2,2,0,0]} />
                      <Line yAxisId="margin" type="monotone" dataKey="margin" stroke="#10b981" strokeWidth={2} dot={false} name="Margin" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Monthly Trend Table */}
              {trendsData.months.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">Monthly Breakdown</h3>
                  <div className="rounded-md border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">Month</th>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground">Loads</th>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground">Spot</th>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground">Margin</th>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground">Avg/Load</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {[...trendsData.months].reverse().map(m => {
                          const [y, mo] = m.monthKey.split("-");
                          const label = new Date(parseInt(y), parseInt(mo) - 1, 1).toLocaleString("default", { month: "short", year: "numeric" });
                          const avg = m.totalLoads > 0 ? m.totalMargin / m.totalLoads : 0;
                          return (
                            <tr key={m.monthKey} className="hover:bg-muted/30 transition-colors">
                              <td className="px-3 py-2 font-medium">{label}</td>
                              <td className="px-3 py-2 text-right">{m.totalLoads}</td>
                              <td className="px-3 py-2 text-right text-muted-foreground">{m.spotLoads}</td>
                              <td className="px-3 py-2 text-right">{m.totalMargin > 0 ? `$${m.totalMargin.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : "—"}</td>
                              <td className="px-3 py-2 text-right text-muted-foreground">{avg > 0 ? `$${avg.toFixed(0)}` : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Top Destinations + Top Corridors side by side */}
              <div className="grid grid-cols-2 gap-4">
                {trendsData.destinations.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold mb-2">Top Delivery Destinations</h3>
                    <div className="rounded-md border overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="text-left px-3 py-2 font-medium text-muted-foreground">Destination</th>
                            <th className="text-right px-3 py-2 font-medium text-muted-foreground">Loads</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {trendsData.destinations.map((d, i) => (
                            <tr key={i} className="hover:bg-muted/30 transition-colors">
                              <td className="px-3 py-1.5">{d.city}{d.state ? `, ${d.state}` : ""}</td>
                              <td className="px-3 py-1.5 text-right font-medium">{d.count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {trendsData.corridors.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold mb-2">Top Lane Corridors</h3>
                    <div className="rounded-md border overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="text-left px-3 py-2 font-medium text-muted-foreground">Lane</th>
                            <th className="text-right px-3 py-2 font-medium text-muted-foreground">Loads</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {trendsData.corridors.map((c, i) => (
                            <tr key={i} className="hover:bg-muted/30 transition-colors">
                              <td className="px-3 py-1.5 text-xs">
                                <span className="font-medium">{c.origin}</span>
                                <span className="text-muted-foreground mx-1">→</span>
                                <span>{c.destination}</span>
                              </td>
                              <td className="px-3 py-1.5 text-right font-medium">{c.loads}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
