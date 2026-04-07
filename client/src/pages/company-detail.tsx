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
  Globe,
  KeyRound,
  Eye,
  EyeOff,
  UserCheck,
  Zap,
  TrendingUp,
  ChevronDown,
  ChevronRight,
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
  Activity,
  Printer,
  Brain,
  Copy,
  Search,
  MoreHorizontal,
} from "lucide-react";
import * as XLSX from "xlsx";
import { InfoTooltip } from "@/components/info-tooltip";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartTooltip,
  ResponsiveContainer, ComposedChart, Line, Legend,
} from "recharts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CompanyDialog } from "@/components/company-dialog";
import { ContactDialog } from "@/components/contact-dialog";
import { ResearchLaneDialog } from "@/components/research-lane-dialog";
import { OrgChart } from "@/components/org-chart";
import { ContactList } from "@/components/contact-list";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateAfterTouchpoint } from "@/lib/invalidations";
import { fmtMoney } from "@/lib/rep-utils";
import { buildAiToasts } from "@/lib/aiTouchUtils";
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
import type { Company, Contact, User, Task, Callout, CalloutReaction, Touchpoint, Rfp, Award } from "@shared/schema";
import { GrowthScoreBadge } from "@/components/account-growth-portlet";
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

type TouchLogEntry = Touchpoint & { loggedByName: string; contactName: string | null };
type MonthBucket = { totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue?: number };
type HealthFactor = { name: string; score: number; max: number; label: string };
type HealthScore = { score: number; grade: string; color: string; momentum: "up" | "flat" | "down"; momentumLabel: string; factors: HealthFactor[] };
type TrendMonth = { monthKey: string; totalLoads: number; spotLoads: number; totalMargin: number };
type TrendDest = { city: string; state: string; count: number };
type TrendCorridor = { origin: string; destination: string; loads: number };
type TrendsData = { months: TrendMonth[]; topDestinations: TrendDest[]; topCorridors: TrendCorridor[]; totalLoads: number; spotLoads: number; totalMargin: number };
type SharedRepEntry = { userId: string; territoryNote: string; name: string };

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
  const [researchDialogOpen, setResearchDialogOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<ResearchTask | null>(null);
  const [findPlannerFacility, setFindPlannerFacility] = useState<Facility | null>(null);
  const [assignExistingContactId, setAssignExistingContactId] = useState<string>("");
  const [portalEdit, setPortalEdit] = useState(false);
  const [portalUrl, setPortalUrl] = useState("");
  const [portalUsername, setPortalUsername] = useState("");
  const [portalPassword, setPortalPassword] = useState("");
  const [salesPersonIdEdit, setSalesPersonIdEdit] = useState<string>("");
  const [showPortalPassword, setShowPortalPassword] = useState(false);
  const [tenderStyle, setTenderStyle] = useState("");
  const [accountQuirks, setAccountQuirks] = useState("");
  const [processNotes, setProcessNotes] = useState("");
  const [spotProcess, setSpotProcess] = useState("");
  const [dlEmail, setDlEmail] = useState("");
  const [operatingHours, setOperatingHours] = useState("");
  const [accountSummary, setAccountSummary] = useState("");
  const [financialAliasEdit, setFinancialAliasEdit] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTo, setTransferTo] = useState("");
  const [viewContact, setViewContact] = useState<Contact | null>(null);
  const [intelContact, setIntelContact] = useState<Contact | null>(null);
  const [orgEmailContact, setOrgEmailContact] = useState<Contact | null>(null);
  const [expandedDeliveryGroups, setExpandedDeliveryGroups] = useState<Set<string>>(new Set());
  const [expandedDeliveryLanes, setExpandedDeliveryLanes] = useState<Set<string>>(new Set());
  const [expandedPickupGroups, setExpandedPickupGroups] = useState<Set<string>>(new Set());
  const [expandedPickupLanes, setExpandedPickupLanes] = useState<Set<string>>(new Set());
  const [quickTouchOpen, setQuickTouchOpen] = useState(false);
  const [quickTouchContactId, setQuickTouchContactId] = useState("");
  const [quickTouchType, setQuickTouchType] = useState("call");
  const [quickTouchNote, setQuickTouchNote] = useState("");
  const [quickTouchSentiment, setQuickTouchSentiment] = useState<string>("");
  const [quickTouchMeaningful, setQuickTouchMeaningful] = useState(false);
  const [walletSharePct, setWalletSharePct] = useState(5);
  const [avgMarginOverride, setAvgMarginOverride] = useState<string>("");
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [editingTaskItem, setEditingTaskItem] = useState<TaskWithCount | undefined>();
  const [focusTaskComments, setFocusTaskComments] = useState(false);
  const [forceLanePrefill, setForceLanePrefill] = useState<{ title: string; notes?: string; attachedLaneData?: any[] } | undefined>();
  const [lanesCollapsed, setLanesCollapsed] = useState(true);
  const [scorecardPending, setScorecardPending] = useState<PendingFile[]>([]);
  const [scorecardUploading, setScorecardUploading] = useState(false);
  const [rfpIntelCollapsed, setRfpIntelCollapsed] = useState(true);
  const [cdRfpDialogOpen, setCdRfpDialogOpen] = useState(false);
  const [cdAwardDialogOpen, setCdAwardDialogOpen] = useState(false);
  const [cdEditingRfp, setCdEditingRfp] = useState<Rfp | undefined>();
  const [cdEditingAward, setCdEditingAward] = useState<Award | undefined>();
  const [cdConvertingRfp, setCdConvertingRfp] = useState<Rfp | null>(null);
  const [cdDeleteRfpTarget, setCdDeleteRfpTarget] = useState<Rfp | null>(null);
  const [cdDeleteAwardTarget, setCdDeleteAwardTarget] = useState<Award | null>(null);
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
  const [selectedTouchpoint, setSelectedTouchpoint] = useState<(Touchpoint & { loggedByName: string; contactName: string | null }) | null>(null);
  const [laneGapInsights, setLaneGapInsights] = useState<Record<string, string>>({});
  const [importRows, setImportRows] = useState<any[]>([]);
  const [importFileName, setImportFileName] = useState("");
  const [detailTab, setDetailTab] = useState<string>(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("rfpTab") && urlParams.get("rfpTab") !== "coverage") return "rfp";
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

  useEffect(() => {
    setAvgMarginOverride("");
  }, [companyId]);

  const { data: company, isLoading: companyLoading, isError: companyError, refetch: refetchCompany } = useQuery<Company>({
    queryKey: ["/api/companies", companyId],
    refetchOnMount: "always",
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
  });

  const { data: touchLogEntries = [] } = useQuery<TouchLogEntry[]>({
    queryKey: ["/api/companies", companyId, "touch-logs"],
    enabled: detailTab === "activity",
  });

  const { data: researchTasks } = useQuery<ResearchTask[]>({
    queryKey: ["/api/research-tasks", { companyId }],
    queryFn: async () => {
      const res = await fetch(`/api/research-tasks?companyId=${companyId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch research tasks");
      return res.json();
    },
    enabled: detailTab === "rfp",
  });

  const { data: facilityCoverage } = useQuery<FacilityCoverage>({
    queryKey: ["/api/companies", companyId, "facility-coverage"],
    enabled: detailTab === "rfp",
  });

  const { data: lanePatterns } = useQuery<LanePatterns>({
    queryKey: ["/api/companies", companyId, "lane-patterns"],
    enabled: detailTab === "rfp",
  });

  const { data: laneMatching } = useQuery<LaneMatching>({
    queryKey: ["/api/companies", companyId, "lane-matching"],
    enabled: detailTab === "rfp",
  });

  const { data: vendorRoutedKeys = [] } = useQuery<string[]>({
    queryKey: ["/api/companies", companyId, "vendor-routed"],
    enabled: detailTab === "rfp",
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

  type GrowthScore = { score: number; band: string; bandLabel: string; bandColor: string; drivers: { label: string; points: number; positive: boolean }[] };
  const { data: growthScore } = useQuery<GrowthScore>({
    queryKey: ["/api/companies", companyId, "growth-score"],
    staleTime: 6 * 60 * 60 * 1000, // 6h — matches server cache window
  });

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

  const { data: trendsData, isLoading: trendsLoading } = useQuery<TrendsData>({
    queryKey: ["/api/companies", companyId, "historical-trends"],
    enabled: showTrends,
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
    mutationFn: ({ contactId, type, notes, sentiment, isMeaningful }: { contactId: string; type: string; notes: string; sentiment?: string; isMeaningful?: boolean }) =>
      apiRequest("POST", `/api/contacts/${contactId}/touchpoints`, { type, date: new Date().toISOString().slice(0, 10), notes, sentiment: sentiment || null, isMeaningful: isMeaningful || false }).then(r => r.json()),
    onSuccess: (data: any) => {
      invalidateAfterTouchpoint(companyId);
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      toast({ title: "Touch logged!" });
      buildAiToasts(data?.aiInsights, data?.autoTask, toast);
      setQuickTouchOpen(false);
      setQuickTouchContactId("");
      setQuickTouchType("call");
      setQuickTouchNote("");
      setQuickTouchSentiment("");
      setQuickTouchMeaningful(false);
    },
    onError: () => toast({ title: "Failed to log touch", variant: "destructive" }),
  });

  const canReassign = currentUser?.role === "admin" || currentUser?.role === "director" || currentUser?.role === "national_account_manager" || currentUser?.role === "sales" || currentUser?.role === "sales_director";
  const { data: assignableUsers = [] } = useQuery<Omit<User, "password">[]>({
    queryKey: ["/api/users"],
    enabled: canReassign,
  });

  const canManageSharedReps = currentUser?.role === "admin" || currentUser?.role === "national_account_manager";
  const { data: sharedReps = [] } = useQuery<SharedRepEntry[]>({
    queryKey: ["/api/companies", companyId, "shared-reps"],
  });

  const [addSharedRepOpen, setAddSharedRepOpen] = useState(false);
  const [newSharedRepUserId, setNewSharedRepUserId] = useState("");
  const [newSharedRepNote, setNewSharedRepNote] = useState("");

  const addSharedRepMutation = useMutation({
    mutationFn: async ({ userId, territoryNote }: { userId: string; territoryNote: string }) => {
      const res = await apiRequest("POST", `/api/companies/${companyId}/shared-reps`, { userId, territoryNote });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "shared-reps"] });
      setAddSharedRepOpen(false);
      setNewSharedRepUserId("");
      setNewSharedRepNote("");
      toast({ title: "Shared rep added" });
    },
    onError: () => toast({ title: "Failed to add shared rep", variant: "destructive" }),
  });

  const removeSharedRepMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await apiRequest("DELETE", `/api/companies/${companyId}/shared-reps/${userId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "shared-reps"] });
      toast({ title: "Shared rep removed" });
    },
    onError: () => toast({ title: "Failed to remove shared rep", variant: "destructive" }),
  });

  const canEditSalesPerson = currentUser?.role === "admin" || currentUser?.role === "director" || currentUser?.role === "national_account_manager" || currentUser?.role === "sales_director";
  const { data: allSalesUsers = [] } = useQuery<Omit<User, "password">[]>({
    queryKey: ["/api/users/sales"],
  });
  const { data: allUsersForSales = [] } = useQuery<Omit<User, "password">[]>({
    queryKey: ["/api/users"],
    enabled: canEditSalesPerson,
  });
  const salesUsers = allUsersForSales.filter(u => u.role === "sales" || u.role === "sales_director").sort((a, b) => a.name.localeCompare(b.name));

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
        operatingHours: operatingHours || null,
        accountSummary: accountSummary.trim() || null,
        salesPersonId: salesPersonIdEdit || null,
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
    setOperatingHours((company as any)?.operatingHours || "");
    setAccountSummary((company as any)?.accountSummary || "");
    setSalesPersonIdEdit((company as any)?.salesPersonId || "");
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
          ...contact,
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
              {canReassign && (
                <DropdownMenuItem
                  onClick={() => { setTransferTo(company.assignedTo || ""); setTransferOpen(true); }}
                  data-testid="dropdown-item-transfer-account"
                >
                  <UserCheck className="h-4 w-4 mr-2" />
                  Transfer Account
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
        <TabsList className="w-full grid grid-cols-5 mb-1">
          <TabsTrigger value="overview" data-testid="tab-detail-overview">Overview</TabsTrigger>
          <TabsTrigger value="activity" data-testid="tab-detail-activity">Activity</TabsTrigger>
          <TabsTrigger value="intelligence" data-testid="tab-detail-intelligence">Intel</TabsTrigger>
          <TabsTrigger value="people" data-testid="tab-detail-people">People</TabsTrigger>
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
            calloutReplyTo={calloutReplyTo}
            setCalloutReplyTo={setCalloutReplyTo}
            setCalloutDialogOpen={setCalloutDialogOpen}
            selectedTouchpoint={selectedTouchpoint}
            setSelectedTouchpoint={setSelectedTouchpoint}
            touchLogCollapsed={touchLogCollapsed}
            setTouchLogCollapsed={setTouchLogCollapsed}
            deleteCalloutMutation={deleteCalloutMutation}
            toggleReactionMutation={toggleReactionMutation}
            toggleTaskStatus={toggleTaskStatus}
            deleteTaskMutation={deleteTaskMutation}
            currentUser={currentUser}
            contacts={contacts}
            setQuickTouchContactId={setQuickTouchContactId}
            setQuickTouchOpen={setQuickTouchOpen}
            setViewContact={setViewContact}
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
            portalEdit={portalEdit}
            setPortalEdit={setPortalEdit}
            portalUrl={portalUrl}
            setPortalUrl={setPortalUrl}
            portalUsername={portalUsername}
            setPortalUsername={setPortalUsername}
            portalPassword={portalPassword}
            setPortalPassword={setPortalPassword}
            showPortalPassword={showPortalPassword}
            setShowPortalPassword={setShowPortalPassword}
            financialAliasEdit={financialAliasEdit}
            setFinancialAliasEdit={setFinancialAliasEdit}
            canEditSalesPerson={canEditSalesPerson}
            salesUsers={salesUsers}
            salesPersonIdEdit={salesPersonIdEdit}
            setSalesPersonIdEdit={setSalesPersonIdEdit}
            tenderStyle={tenderStyle}
            setTenderStyle={setTenderStyle}
            accountQuirks={accountQuirks}
            setAccountQuirks={setAccountQuirks}
            processNotes={processNotes}
            setProcessNotes={setProcessNotes}
            spotProcess={spotProcess}
            setSpotProcess={setSpotProcess}
            dlEmail={dlEmail}
            setDlEmail={setDlEmail}
            operatingHours={operatingHours}
            setOperatingHours={setOperatingHours}
            accountSummary={accountSummary}
            setAccountSummary={setAccountSummary}
            openPortalEdit={openPortalEdit}
            savePortalMutation={savePortalMutation}
            transferOpen={transferOpen}
            setTransferOpen={setTransferOpen}
            transferTo={transferTo}
            setTransferTo={setTransferTo}
            assignableUsers={assignableUsers}
            reassignMutation={reassignMutation}
            scorecardPending={scorecardPending}
            setScorecardPending={setScorecardPending}
            scorecardUploading={scorecardUploading}
            setScorecardUploading={setScorecardUploading}
            walletSharePct={walletSharePct}
            setWalletSharePct={setWalletSharePct}
            avgMarginOverride={avgMarginOverride}
            setAvgMarginOverride={setAvgMarginOverride}
            teamMembers={teamMembers}
            sharedReps={sharedReps}
            addSharedRepOpen={addSharedRepOpen}
            setAddSharedRepOpen={setAddSharedRepOpen}
            newSharedRepUserId={newSharedRepUserId}
            setNewSharedRepUserId={setNewSharedRepUserId}
            newSharedRepNote={newSharedRepNote}
            setNewSharedRepNote={setNewSharedRepNote}
            addSharedRepMutation={addSharedRepMutation}
            removeSharedRepMutation={removeSharedRepMutation}
            canManageSharedReps={canManageSharedReps}
            allSalesUsers={allSalesUsers}
            allUsersForSales={allUsersForSales}
            accountPerf={accountPerf}
            companyRfps={companyRfps}
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
            setQuickTouchContactId={setQuickTouchContactId}
            setQuickTouchOpen={setQuickTouchOpen}
            setEditingTaskItem={setEditingTaskItem}
            setForceLanePrefill={setForceLanePrefill}
            setTaskDialogOpen={setTaskDialogOpen}
            setOrgEmailContact={setOrgEmailContact}
            currentUser={currentUser}
          />
        </TabsContent>

        <TabsContent value="rfp" className="space-y-4 mt-2">
          <RfpTab
            company={company!}
            companyId={companyId}
            companyRfps={companyRfps}
            companyAwards={companyAwards}
            facilityCoverage={facilityCoverage}
            lanePatterns={lanePatterns}
            laneMatching={laneMatching}
            vendorRoutedKeys={vendorRoutedKeys}
            vendorRoutedToggle={vendorRoutedToggle}
            laneGapInsights={laneGapInsights}
            laneGapInsightsMutation={laneGapInsightsMutation}
            rfpIntelDefaultTab={rfpIntelTab}
            rfpIntelCollapsed={rfpIntelCollapsed}
            setRfpIntelCollapsed={setRfpIntelCollapsed}
            researchTasks={researchTasks}
            canReassign={canReassign}
            setFindPlannerFacility={setFindPlannerFacility}
            setAssignExistingContactId={setAssignExistingContactId}
            handleAssignTask={handleAssignTask}
            markResearchedMutation={markResearchedMutation}
            lanesCollapsed={lanesCollapsed}
            setLanesCollapsed={setLanesCollapsed}
            contacts={contacts}
            companyTouchpoints={companyTouchpoints}
            touchpointsThisMonth={touchpointsThisMonth}
            handleEditContact={handleEditContact}
            setViewContact={setViewContact}
            setTaskDialogOpen={setTaskDialogOpen}
            setEditingTaskItem={setEditingTaskItem}
            setForceLanePrefill={setForceLanePrefill}
            cdRfpDialogOpen={cdRfpDialogOpen}
            setCdRfpDialogOpen={setCdRfpDialogOpen}
            cdEditingRfp={cdEditingRfp}
            setCdEditingRfp={setCdEditingRfp}
            cdAwardDialogOpen={cdAwardDialogOpen}
            setCdAwardDialogOpen={setCdAwardDialogOpen}
            cdEditingAward={cdEditingAward}
            setCdEditingAward={setCdEditingAward}
            cdConvertingRfp={cdConvertingRfp}
            setCdConvertingRfp={setCdConvertingRfp}
            cdDeleteRfpTarget={cdDeleteRfpTarget}
            setCdDeleteRfpTarget={setCdDeleteRfpTarget}
            cdDeleteAwardTarget={cdDeleteAwardTarget}
            setCdDeleteAwardTarget={setCdDeleteAwardTarget}
            cdDeleteRfpMutation={cdDeleteRfpMutation}
            cdDeleteAwardMutation={cdDeleteAwardMutation}
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

      <Dialog open={quickTouchOpen} onOpenChange={open => { if (!open) { setQuickTouchOpen(false); setQuickTouchContactId(""); setQuickTouchType("call"); setQuickTouchNote(""); setQuickTouchSentiment(""); setQuickTouchMeaningful(false); } }}>
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
            {/* Meaningful toggle */}
            <div className="flex items-center gap-3 py-1">
              <button
                type="button"
                onClick={() => setQuickTouchMeaningful(v => !v)}
                data-testid="button-meaningful-toggle"
                className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${quickTouchMeaningful ? "bg-green-500" : "bg-muted border border-border"}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${quickTouchMeaningful ? "left-4" : "left-0.5"}`} />
              </button>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium">Meaningful conversation?</span>
                <span
                  className="text-[10px] text-muted-foreground cursor-help border-b border-dashed border-muted-foreground"
                  title="A real conversation that moves the needle — freight needs, rates, an opportunity, or account strategy. Not just 'what are you working on?'"
                  data-testid="tooltip-meaningful"
                >
                  What's this?
                </span>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Notes {quickTouchMeaningful ? <span className="text-red-500">*required for meaningful</span> : <span className="font-normal">(optional)</span>}
              </label>
              <textarea
                value={quickTouchNote}
                onChange={e => setQuickTouchNote(e.target.value)}
                placeholder={quickTouchMeaningful ? "What made this conversation meaningful?" : "What did you discuss? Any follow-ups?"}
                rows={3}
                data-testid="textarea-quick-touch-note-detail"
                className={`w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none ${quickTouchMeaningful && !quickTouchNote.trim() ? "border-red-300 dark:border-red-700" : "border-input"}`}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Call Vibe <span className="font-normal">(optional)</span></label>
              <div className="flex gap-2">
                {[{ value: "positive", label: "😊 Positive" }, { value: "neutral", label: "😐 Neutral" }, { value: "negative", label: "😟 Negative" }].map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setQuickTouchSentiment(quickTouchSentiment === opt.value ? "" : opt.value)}
                    data-testid={`button-sentiment-${opt.value}`}
                    className={`flex-1 py-1.5 text-xs rounded-md border transition-colors ${
                      quickTouchSentiment === opt.value
                        ? opt.value === "positive" ? "bg-green-100 text-green-800 border-green-300 dark:bg-green-900/40 dark:text-green-300"
                          : opt.value === "neutral" ? "bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/40 dark:text-blue-300"
                          : "bg-red-100 text-red-800 border-red-300 dark:bg-red-900/40 dark:text-red-300"
                        : "border-border text-muted-foreground hover:bg-muted"
                    }`}
                  >{opt.label}</button>
                ))}
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => { setQuickTouchOpen(false); setQuickTouchNote(""); setQuickTouchSentiment(""); setQuickTouchMeaningful(false); }} data-testid="button-cancel-quick-touch-detail">Cancel</Button>
              <Button
                className="flex-1"
                disabled={!quickTouchContactId || logTouchFromDetailMutation.isPending || (quickTouchMeaningful && !quickTouchNote.trim())}
                onClick={() => logTouchFromDetailMutation.mutate({ contactId: quickTouchContactId, type: quickTouchType, notes: quickTouchNote, sentiment: quickTouchSentiment || undefined, isMeaningful: quickTouchMeaningful })}
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
                {(trendsData.topDestinations ?? []).length > 0 && (
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
                          {(trendsData.topDestinations ?? []).map((d, i) => (
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

                {(trendsData.topCorridors ?? []).length > 0 && (
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
                          {(trendsData.topCorridors ?? []).map((c, i) => (
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
    </div>
  );
}
