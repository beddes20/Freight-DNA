/**
 * CarrierOutreachPanel — Lane-level carrier outreach workspace
 *
 * Workflow:
 *   1. Select a recurring lane from the Lane Work Queue
 *   2. Review ranked carrier suggestions
 *   3. Draft lane-building outreach emails
 *   4. Send or log outreach
 *   5. Track responses on the bench
 *   6. Receive follow-up suggestions
 */

import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { formatLaneDisplay, formatLaneLocation, formatWeeklyLoadRange } from "@shared/laneFormatters";
import { CarrierReasonsPopover } from "@/components/CarrierReasonsPopover";
import {
  CarrierOverrideReasonPicker,
  type CarrierOverrideAction,
  type CarrierOverridePickerCarrier,
  type CarrierOverridePickerLane,
} from "@/components/CarrierOverrideReasonPicker";
import {
  OUTREACH_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  applyLaneVars,
  applyTemplateVars,
} from "@/lib/outreachTemplates";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Truck,
  Mail,
  Send,
  CheckCircle2,
  AlertCircle,
  Loader2,
  User,
  UserX,
  UserCheck,
  History,
  ChevronDown,
  ChevronUp,
  Plus,
  Copy,
  XCircle,
  ClipboardCheck,
  Upload,
  ExternalLink,
  Lightbulb,
  Search,
  ShieldCheck,
  ShieldAlert,
  TrendingUp,
  Star,
  Clock,
  MailOpen,
  PenLine,
  Check,
  AlertTriangle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";

interface TeamMember {
  id: string;
  name: string;
  role: string;
}

interface RecurringLane {
  id: string;
  companyId: string;
  origin: string;
  originState: string;
  destination: string;
  destinationState: string;
  equipmentType: string | null;
  avgLoadsPerWeek: number | null;
  weeksActive: number | null;
  lookbackWeeks: number | null;
  laneScore: number | null;
  eligibilityConfidence: string | null;
  carriersContactedCount: number;
  resolvedAt: string | null;
  hasPreferredCarrierProgram: boolean;
  ownerUserId: string | null;
  overseerUserId: string | null;
  dropTrailerShipper: boolean;
  dropTrailerReceiver: boolean;
}

interface WhyThisCarrier {
  primarySignal: string;
  fitBand: "strong" | "good" | "moderate" | "low";
  claimedLaneMatch: boolean;
  hasExactHistory: boolean;
  exactHistoryRuns?: number;
  hasSimilarHistory: boolean;
  hasCustomerHistory: boolean;
  customerHistoryLoads?: number;
  priorPositiveOutreach: boolean;
  recentlyContacted: boolean;
  recentlyContactedNote?: string;
  hasMarketNbaBoost?: boolean;
}

interface CarrierFitExplanation {
  exactLaneHistory: { runCount: number; lastRunDate: string | null };
  regionalHistory: { runCount: number };
  customerHistory: { hasHistory: boolean; runCount: number };
  outreachHistory: { lastStatus: string | null; lastDate: string | null };
  fitSignals: {
    regionEquipmentFitScore: number;
    laneHistoryScore: number;
    customerHistoryScore: number;
    hasMarketNbaBoost: boolean;
  };
}

interface RankedCarrier {
  carrierId: string | null;
  carrierName: string;
  mcDot: string | null;
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
  sourceChannel: string | null;
  suppressionReasons: string[];
  customerHistoryLoads: number;
  hasMarketNbaBoost?: boolean;
  whyThisCarrier?: WhyThisCarrier;
  carrierFitExplanation?: CarrierFitExplanation | null;
  // Task #632 — Bench tier-0: positive lane outcomes within 90d.
  bench?: boolean;
  benchWins?: number;
  // Task #633 — capped, ordered "why this carrier" reasons (server: ranker).
  reasons?: string[];
}

interface SuggestionsResponse {
  carriers: RankedCarrier[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  isHighFrequencyLane?: boolean;
  highFrequencyConfig?: {
    minLoadsPerWeek: number;
    frequencyLookbackDays: number;
    maxCandidates: number;
    outreachDedupWindowHours: number;
  };
}

interface CoverageProfile {
  id: string;
  laneId: string;
  coverageStatus: string;
  sampleSize: number;
  qualifiedCarrierCount: number;
  topCarrierCoverageShare: string | null;
  manualOverrideStatus: string | null;
  manualOverrideReason: string | null;
  broadenSearchActive: boolean;
  manuallyConfirmedAt: string | null;
  updatedAt: string | null;
}

interface CoverageProfileCarrier {
  id: string;
  carrierId: string | null;
  carrierName: string;
  incumbentRank: number;
  successfulLoadCount: number;
  recentLoadCount: number;
  coverageShare: string | null;
  lastUsedAt: string | null;
  isCurrentPrimary: boolean;
}

interface ParsedImportCarrier {
  name: string;
  email?: string;
  phone?: string;
  mcDot?: string;
}

interface ImportResult {
  carrier: { id: string; name: string; primaryEmail?: string | null; sourceChannel?: string | null };
  status: "new" | "matched";
  matchType?: "email_exact" | "mc_exact" | "name_fuzzy";
  addedToBench: boolean;
}

const SOURCE_LABELS: Record<string, string> = {
  dat: "DAT",
  loadsmart: "Loadsmart",
  csv_paste: "Paste Import",
  import_paste: "Paste Import",
  manual: "Manual",
  engine: "Engine",
  excel_seed: "Excel Seed",
  other: "Other",
};

const SOURCE_COLORS: Record<string, string> = {
  dat: "border-sky-500/40 text-sky-400",
  loadsmart: "border-violet-500/40 text-violet-400",
  import_paste: "border-teal-500/40 text-teal-400",
  csv_paste: "border-teal-500/40 text-teal-400",
  manual: "border-border text-muted-foreground",
  engine: "border-blue-500/40 text-blue-400",
  excel_seed: "border-emerald-500/40 text-emerald-400",
  other: "border-border text-muted-foreground",
};

interface EmailDraft {
  carrierId: string | null;
  carrierName: string;
  subject: string;
  body: string;
  outreachMode: string;
  recipientEmail?: string | null;
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

interface OutreachLog {
  id: string;
  carrierNames: string[];
  outreachMode: string;
  timestamp: string;
  sentAt: string | null;
  deliveryStatus: string | null;
  failureReason: string | null;
  recipients: Array<{
    carrierId: string | null;
    carrierName: string;
    email: string | null;
    status: "sent" | "failed" | "no_email";
    error?: string;
    internetMessageId?: string;
  }> | null;
  emailDrafts: EmailDraft[] | null;
  replyReceivedAt: string | null;
  replySnippet: string | null;
}

type PerDraftSendStatus = "idle" | "sending" | "sent" | "failed" | "no_email" | "dedup_skipped" | "throttled_daily_cap" | "throttled_too_soon";

// ── Constants ────────────────────────────────────────────────────────────────

const INTEREST_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  available_now:      { label: "Available Now",    color: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  available_next_week:{ label: "Next Week",         color: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30" },
  future_interest:    { label: "Future Interest",   color: "bg-violet-500/20 text-violet-300 border-violet-500/30" },
  not_fit:            { label: "Not a Fit",         color: "bg-red-500/20 text-red-300 border-red-500/30" },
  needs_follow_up:    { label: "Needs Follow-up",   color: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
};

const HISTORY_MATCH_LABELS: Record<string, string> = {
  exact:      "Ran this lane",
  nearby:     "Nearby lane",
  state_pair: "Same corridor",
  similar:    "Similar corridor",
  region:     "In region",
  none:       "New prospect",
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
  const { data: companyLanes } = useQuery<RecurringLane[]>({
    queryKey: ["/api/recurring-lanes"],
    enabled: !laneIdProp && open,
  });

  const laneId = laneIdProp ?? (
    (companyLanes ?? [])
          // IMPORTANT: filter by companyId to avoid showing outreach for wrong account
          .filter(l => l.companyId === companyId && !l.resolvedAt && !l.hasPreferredCarrierProgram)
          .sort((a, b) => (b.laneScore ?? 0) - (a.laneScore ?? 0))[0]?.id ?? null
  );

  const { data: outreachConfig } = useQuery<{ completionCarriersContacted: number }>({
    queryKey: ["/api/outreach-config"],
    enabled: open,
  });

  const completionThreshold = outreachConfig?.completionCarriersContacted ?? 3;

  const { data: teamMembers = [] } = useQuery<TeamMember[]>({
    queryKey: ["/api/team-members"],
    enabled: open,
  });

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuth();
  const isDirectorOrAdmin = ["admin", "director"].includes(currentUser?.role ?? "");
  const isManager = ["admin", "director", "national_account_manager", "logistics_manager"].includes(currentUser?.role ?? "");
  const canCorrectEmails = ["admin", "sales_director", "director"].includes(currentUser?.role ?? "");

  const [correctionLog, setCorrectionLog] = useState<OutreachLog | null>(null);
  const [correctionDraft, setCorrectionDraft] = useState<EmailDraft | null>(null);
  const [correctedText, setCorrectedText] = useState("");
  const [correctionNotes, setCorrectionNotes] = useState("");

  const outreachCorrectionMutation = useMutation({
    mutationFn: async (params: { outreachLogId: string; originalText: string; correctedText: string; correctionNotes?: string; subject?: string; carrierId?: string }) => {
      const res = await apiRequest("POST", "/api/email-corrections", {
        outreachLogId: params.outreachLogId,
        originalText: params.originalText,
        correctedText: params.correctedText,
        correctionNotes: params.correctionNotes || undefined,
        carrierId: params.carrierId || undefined,
        subject: params.subject || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Correction saved", description: "AI will learn from this in future carrier outreach." });
      setCorrectionLog(null);
      setCorrectionDraft(null);
      setCorrectedText("");
      setCorrectionNotes("");
      queryClient.invalidateQueries({ queryKey: ["/api/email-corrections"] });
    },
    onError: () => {
      toast({ title: "Failed to save correction", variant: "destructive" });
    },
  });

  const [selectedCarriers, setSelectedCarriers] = useState<Set<string>>(new Set());
  const [outreachMode, setOutreachMode] = useState<"lane_building" | "immediate_plus_lane">("lane_building");
  const [emailDrafts, setEmailDrafts] = useState<EmailDraft[]>([]);
  const [showEmails, setShowEmails] = useState(false);
  const [replyInputs, setReplyInputs] = useState<Record<string, string>>({});
  const [expandedReply, setExpandedReply] = useState<string | null>(null);

  const [draftSendStatus, setDraftSendStatus] = useState<Record<number, PerDraftSendStatus>>({});
  const [sendOverallStatus, setSendOverallStatus] = useState<"idle" | "sending" | "done">("idle");
  // Carrier suggestion filters
  const [activeOnly, setActiveOnly] = useState(false);
  const [excludeServiceFlags, setExcludeServiceFlags] = useState(false);
  // New: filter/sort/pagination state
  const [pageSize, setPageSize] = useState(25);
  const [currentPage, setCurrentPage] = useState(1);
  const [sortOption, setSortOption] = useState("recommended");
  const [filterExactOnly, setFilterExactOnly] = useState(false);
  const [filterHasEmail, setFilterHasEmail] = useState(false);
  const [filterNotRecentlyContacted, setFilterNotRecentlyContacted] = useState(false);
  const [filterIncludeNewProspects, setFilterIncludeNewProspects] = useState(true);
  const [overrideRecentlyContacted, setOverrideRecentlyContacted] = useState(false);
  const [historicalSectionCollapsed, setHistoricalSectionCollapsed] = useState(false);
  // Confirmation dialog state for bulk send
  const [sendConfirmOpen, setSendConfirmOpen] = useState(false);
  const [sendConfirmOverride, setSendConfirmOverride] = useState(false);
  // ── Redesign: step-based navigation ────────────────────────────────────────
  const [activeMainTab, setActiveMainTab] = useState<"carriers" | "message" | "followup" | "history">("carriers");

  const { data: outreachCorrections } = useQuery<{ corrections: { outreachLogId: string }[] }>({
    queryKey: ["/api/email-corrections", { forHistory: true }],
    queryFn: async () => {
      const res = await fetch(`/api/email-corrections?hasOutreachLog=1`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: open && activeMainTab === "history",
  });
  const correctedOutreachIds = new Set((outreachCorrections?.corrections ?? []).map(c => c.outreachLogId).filter(Boolean));

  const [activeCarriersSubTab, setActiveCarriersSubTab] = useState<"ranked" | "bench" | "import">("ranked");
  const [showRefineFilters, setShowRefineFilters] = useState(false);
  // Inline email notes per carrier (keyed by carrierId ?? carrierName)
  const [inlineEmails, setInlineEmails] = useState<Record<string, string>>({});
  // User-entered email addresses for carriers that have no primaryEmail in the catalog
  const [capturedEmails, setCapturedEmails] = useState<Record<string, string>>({});
  // Shared outreach template that applies to all selected carriers
  const [sharedTemplate, setSharedTemplate] = useState("");
  // ── Template selector state ────────────────────────────────────────────────
  const [sharedSubject, setSharedSubject] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(DEFAULT_TEMPLATE_ID);
  // Track what was last applied by the selector (for dirty detection)
  const [lastAppliedBody, setLastAppliedBody] = useState("");
  const [lastAppliedSubject, setLastAppliedSubject] = useState("");
  // Non-null while waiting for user to confirm a template switch over unsaved edits
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);
  // ── Bulk edit & apply to all modal state ──────────────────────────────────
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkEditSubject, setBulkEditSubject] = useState("");
  const [bulkEditBody, setBulkEditBody] = useState("");
  const [bulkEditSourceIndex, setBulkEditSourceIndex] = useState<number>(0);
  const [draftsFromTemplate, setDraftsFromTemplate] = useState(false);
  // Tracks which lane ID we have already applied the initial default template for
  const initialTemplateAppliedRef = useRef<string | null>(null);
  // ── Import tab state ──────────────────────────────────────────────────────
  const [importPasteText, setImportPasteText] = useState("");
  const [importSource, setImportSource] = useState("dat");
  const [parsedImportCarriers, setParsedImportCarriers] = useState<ParsedImportCarrier[] | null>(null);
  const [importResults, setImportResults] = useState<ImportResult[] | null>(null);
  // ── Ad-hoc email paste state ───────────────────────────────────────────────
  const [adHocEmailPasteText, setAdHocEmailPasteText] = useState("");
  const [adHocEmailsExpanded, setAdHocEmailsExpanded] = useState(false);
  // ── Coverage tab expanded detail ───────────────────────────────────────────
  const [coverageExpanded, setCoverageExpanded] = useState(false);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const { data: lane, isLoading: laneLoading } = useQuery<RecurringLane>({
    queryKey: ["/api/recurring-lanes", laneId],
    queryFn: () => fetch(`/api/recurring-lanes/${laneId}`).then(r => r.json()),
    enabled: !!laneId && open,
  });

  // Lean detail query — fetches replySummary and bench counts separately from the list.
  // Note: this data is prefetched on hover in lane-work-queue.tsx so it's often already cached
  // when the panel opens. staleTime matches the prefetch so we don't re-fetch unnecessarily.
  const { data: laneDetail } = useQuery<{
    laneId: string;
    replySummary: {
      totalReplied: number;
      hotCount: number;
      topStatus: string | null;
      topCarrierName: string | null;
      needsAction: boolean;
    };
    totalBenchCount: number;
    historicalCount: number;
  }>({
    queryKey: ["/api/recurring-lanes", laneId, "detail"],
    queryFn: () => fetch(`/api/recurring-lanes/${laneId}/detail`).then(r => r.json()),
    enabled: !!laneId && open,
    staleTime: 2 * 60 * 1000,
  });

  const suggestionsQueryParams = new URLSearchParams({
    pageSize: String(pageSize),
    page: String(currentPage),
    sort: sortOption,
    ...(filterExactOnly ? { exactOnly: "true" } : {}),
    ...(filterHasEmail ? { hasEmail: "true" } : {}),
    ...(filterNotRecentlyContacted ? { notRecentlyContacted: "true" } : {}),
    ...(activeOnly ? { activeOnly: "true" } : {}),
    ...(!filterIncludeNewProspects ? { includeNewProspects: "false" } : {}),
    ...(overrideRecentlyContacted ? { overrideRecentlyContacted: "true" } : {}),
  }).toString();

  const { data: suggestionsData, isLoading: suggestionsLoading, isError: suggestionsError, error: suggestionsErrorObj, refetch: refetchSuggestions } = useQuery<SuggestionsResponse>({
    queryKey: ["/api/lanes", laneId, "carrier-suggestions", suggestionsQueryParams],
    queryFn: async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const r = await fetch(`/api/lanes/${laneId}/carrier-suggestions?${suggestionsQueryParams}`, { signal: controller.signal });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `Server error (${r.status})`);
        }
        return r.json();
      } finally {
        clearTimeout(timeout);
      }
    },
    enabled: !!laneId && open,
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    retry: 1,
    retryDelay: 2000,
  });

  // Pre-populate capturedEmails from carrier primaryEmail so the email input
  // auto-fills with the saved address on subsequent panel opens.
  useEffect(() => {
    if (!suggestionsData?.carriers) return;
    setCapturedEmails(prev => {
      const next = { ...prev };
      for (const c of suggestionsData.carriers) {
        const key = c.carrierId ?? c.carrierName;
        // Only pre-fill if the user hasn't already typed something into the field
        if (c.primaryEmail && !next[key]) {
          next[key] = c.primaryEmail;
        }
      }
      return next;
    });
  }, [suggestionsData]);

  // Apply the default template (with lane vars substituted) the first time a lane loads.
  // Skips re-application if the rep has already edited the content.
  useEffect(() => {
    if (!lane || lane.id === initialTemplateAppliedRef.current) return;
    initialTemplateAppliedRef.current = lane.id;
    const tpl = OUTREACH_TEMPLATES.find(t => t.id === selectedTemplateId) ?? OUTREACH_TEMPLATES[0];
    const laneVars = {
      origin: formatLaneLocation(lane.origin, lane.originState),
      destination: formatLaneLocation(lane.destination, lane.destinationState),
      equipmentType: lane.equipmentType ?? "dry van",
    };
    const body = applyLaneVars(tpl.body, laneVars);
    const subj = applyLaneVars(tpl.subject, laneVars);
    setSharedTemplate(body);
    setSharedSubject(subj);
    setLastAppliedBody(body);
    setLastAppliedSubject(subj);
  }, [lane?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: bench = [], refetch: refetchBench } = useQuery<CarrierInterest[]>({
    queryKey: ["/api/lanes", laneId, "carrier-bench"],
    queryFn: () => fetch(`/api/lanes/${laneId}/carrier-bench`).then(r => r.json()),
    enabled: !!laneId && open,
  });

  const { data: coverageData, refetch: refetchCoverage, isLoading: coverageLoading } = useQuery<{ profile: CoverageProfile; carriers: CoverageProfileCarrier[] }>({
    queryKey: ["/api/lanes", laneId, "coverage-profile"],
    queryFn: () => fetch(`/api/lanes/${laneId}/coverage-profile`).then(r => r.ok ? r.json() : null),
    enabled: !!laneId && open,
    staleTime: 5 * 60 * 1000,
    retry: false,
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
      // Invalidate carrier suggestions so updated primaryEmail values are reflected next load
      queryClient.invalidateQueries({ queryKey: ["/api/lanes", laneId, "carrier-suggestions"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/lanes", laneId, "carrier-bench"] });
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
    onSuccess: (_data, ownerUserId) => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes", laneId] });
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: ownerUserId === null ? "Lane unassigned" : "Lane assigned" });
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

  const sendOutreachMutation = useMutation({
    mutationFn: (body: {
      emailDrafts: EmailDraft[];
      outreachMode: string;
      capturedEmails?: Record<string, string>;
    }) => apiRequest("POST", `/api/lanes/${laneId}/send-outreach-emails`, body).then(r => r.json()),
    onSuccess: (data: { results: Array<{ carrierId: string | null; carrierName: string; email: string | null; status: string; error?: string; throttleReason?: string; throttleMessage?: string }>; sentCount: number; failedCount: number; throttledCount?: number; carriersContactedCount: number; resolved: boolean }) => {
      // Map results back to per-draft statuses by index (safer than name-match for duplicate ad-hoc entries)
      const newStatuses: Record<number, PerDraftSendStatus> = {};
      emailDrafts.forEach((_draft, idx) => {
        newStatuses[idx] = (data.results[idx]?.status as PerDraftSendStatus) ?? "idle";
      });
      setDraftSendStatus(newStatuses);
      setSendOverallStatus("done");
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes", laneId] });
      queryClient.invalidateQueries({ queryKey: ["/api/lanes", laneId, "carrier-bench"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lanes", laneId, "outreach-history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/nba/cards"] });
      // Invalidate carrier suggestions so updated primaryEmail values are reflected next load
      queryClient.invalidateQueries({ queryKey: ["/api/lanes", laneId, "carrier-suggestions"] });
      // Invalidate carrier hub profiles for any carriers whose emails were persisted
      for (const draft of emailDrafts) {
        if (draft.carrierId) {
          queryClient.invalidateQueries({ queryKey: ["/api/carrier-hub", draft.carrierId] });
        }
      }
      refetchBench();
      if (data.resolved) {
        onCarriersContacted?.();
        toast({ title: "Lane bench complete!", description: "Carrier emails sent — bench resolved. Snoozing 30 days." });
      } else if (data.sentCount === 0 && data.failedCount === 0) {
        const skipReasons: string[] = [];
        const noEmailCt = data.results.filter((r: { status: string }) => r.status === "no_email").length;
        const dedupCt = data.results.filter((r: { status: string }) => r.status === "dedup_skipped").length;
        const dailyCapCt = data.results.filter((r: { status: string }) => r.status === "throttled_daily_cap").length;
        const tooSoonCt = data.results.filter((r: { status: string }) => r.status === "throttled_too_soon").length;
        if (noEmailCt > 0) skipReasons.push(`${noEmailCt} missing email`);
        if (dedupCt > 0) skipReasons.push(`${dedupCt} recently contacted`);
        if (dailyCapCt > 0) skipReasons.push(`${dailyCapCt} daily limit reached`);
        if (tooSoonCt > 0) skipReasons.push(`${tooSoonCt} sent too recently`);
        toast({ title: "No emails sent", description: skipReasons.length ? skipReasons.join(", ") + "." : "All carriers were skipped.", variant: "destructive" });
      } else if (data.failedCount === 0) {
        toast({ title: `${data.sentCount} email${data.sentCount > 1 ? "s" : ""} sent!`, description: "Outreach logged to lane history." });
      } else if (data.sentCount > 0) {
        toast({ title: `${data.sentCount} sent, ${data.failedCount} failed`, description: "Check per-carrier status below.", variant: "destructive" });
      } else {
        toast({ title: "All sends failed", description: data.results.map((r: { error?: string }) => r.error).filter(Boolean).join("; "), variant: "destructive" });
      }
    },
    onError: () => {
      setSendOverallStatus("idle");
      toast({ title: "Send failed", description: "Could not reach the email service. Verify configuration.", variant: "destructive" });
    },
  });

  const { data: outreachHistory = [], refetch: refetchHistory, isLoading: isHistoryLoading, isError: isHistoryError } = useQuery<OutreachLog[]>({
    queryKey: ["/api/lanes", laneId, "outreach-history"],
    queryFn: async () => {
      const r = await fetch(`/api/lanes/${laneId}/outreach-log`);
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error ?? `Failed to load outreach history (${r.status})`);
      }
      return r.json();
    },
    enabled: !!laneId && open,
  });

  const isAdmin = currentUser?.role === "admin" || currentUser?.role === "owner";
  const { data: replyTrackingStatus } = useQuery<{
    enabled: boolean;
    mailbox: string | null;
    subscriptionActive: boolean;
    missingPermissions: string[];
    warnings: string[];
  }>({
    queryKey: ["/api/admin/graph-reply-status"],
    enabled: isAdmin && open && activeMainTab === "history",
    staleTime: 5 * 60 * 1000,
  });

  const importCarriersMutation = useMutation({
    mutationFn: (body: { carriers: ParsedImportCarrier[]; source: string; rawInput?: string }) =>
      apiRequest("POST", `/api/lanes/${laneId}/import-carriers`, body).then(r => r.json()),
    onSuccess: (data: { batch: { id: string; newCount: number; matchedCount: number }; results: ImportResult[] }) => {
      setImportResults(data.results);
      queryClient.invalidateQueries({ queryKey: ["/api/lanes", laneId, "carrier-bench"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lanes", laneId, "carrier-suggestions"] });
      refetchBench();
      toast({
        title: `${data.batch.newCount} new carrier${data.batch.newCount !== 1 ? "s" : ""} imported`,
        description: data.batch.matchedCount > 0
          ? `${data.batch.matchedCount} already in catalog. All ${data.results.length} added to bench.`
          : `All added to bench.`,
      });
      // Task #638 — Single-carrier imports are the prototypical "added
      // outside top-N" signal. Multi-carrier paste-ins are typically
      // bulk catalog seeding, not a per-carrier preference, so we skip
      // the picker for those to avoid an N-dialog avalanche.
      if (data.results.length === 1) {
        const r = data.results[0];
        if (r?.carrier?.id) {
          setOverridePicker({
            carrier: { carrierId: r.carrier.id, carrierName: r.carrier.name },
            lane: pickerLane(),
            action: "added_outside_topn",
          });
        }
      }
    },
    onError: () => {
      toast({ title: "Import failed", description: "Could not import carriers. Please try again.", variant: "destructive" });
    },
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  const rankedCarriers = suggestionsData?.carriers ?? [];
  const totalCount = suggestionsData?.totalCount ?? 0;
  const totalPages = suggestionsData?.totalPages ?? 1;
  const isHighFrequencyLane = suggestionsData?.isHighFrequencyLane ?? false;

  // Apply remaining frontend-only filters (service flags — not in server params)
  const filteredCarriers = rankedCarriers.filter(c => {
    if (excludeServiceFlags) {
      const flagTags = ["do_not_use", "service_flag", "flagged", "no_use"];
      if (c.tags.some(t => flagTags.includes(t.toLowerCase()))) return false;
    }
    return true;
  });

  // Historical carriers: carrierId === null (from financial history, not in catalog)
  const historicalCarriers = filteredCarriers.filter(c => c.carrierId === null && c.historyMatch === "exact");
  const catalogCarriersWithExactHistory = filteredCarriers.filter(c => c.carrierId !== null && c.historyMatch === "exact");

  // Task #638 — Reason picker state. We capture only single-carrier actions
  // here so a "Select all" / "Top 30" power move never spams reps with N
  // dialogs. Lane fields come from the lane query above.
  const [overridePicker, setOverridePicker] = useState<{
    carrier: CarrierOverridePickerCarrier;
    lane: CarrierOverridePickerLane;
    action: CarrierOverrideAction;
  } | null>(null);

  function pickerLane(): CarrierOverridePickerLane {
    return {
      origin: lane?.origin ?? null,
      originState: lane?.originState ?? null,
      destination: lane?.destination ?? null,
      destinationState: lane?.destinationState ?? null,
      equipmentType: lane?.equipmentType ?? null,
    };
  }

  function toggleCarrier(c: RankedCarrier) {
    const key = c.carrierId ?? c.carrierName;
    const wasSelected = selectedCarriers.has(key);
    setSelectedCarriers(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    // Task #638 — Top-3 deselect signals "ranker got this wrong". Only fire
    // for catalog carriers (carrierId !== null) so the override row has a
    // valid FK target. The rank used here is the carrier's index in the
    // current sort order, which mirrors what the rep sees on screen.
    if (wasSelected && c.carrierId) {
      const rankIdx = filteredCarriers.findIndex(rc => (rc.carrierId ?? rc.carrierName) === key);
      if (rankIdx >= 0 && rankIdx < 3) {
        setOverridePicker({
          carrier: { carrierId: c.carrierId, carrierName: c.carrierName },
          lane: pickerLane(),
          action: "deselect_top3",
        });
      }
    }
  }

  function selectAllFiltered() {
    const keys = filteredCarriers.map(c => c.carrierId ?? c.carrierName);
    setSelectedCarriers(new Set(keys));
  }

  function clearSelection() {
    setSelectedCarriers(new Set());
  }

  function selectTopN(n: number) {
    const keys = filteredCarriers.slice(0, n).map(c => c.carrierId ?? c.carrierName);
    setSelectedCarriers(new Set(keys));
  }

  /**
   * Smart parser — handles tab-delimited (DAT), CSV, pipe-delimited, or freeform.
   * Attempts to detect name | email | phone | MC# from each line.
   * Returns array of ParsedImportCarrier objects.
   */
  function parseImportText(raw: string): ParsedImportCarrier[] {
    const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
    const MC_RE = /\bMC[-#\s]?(\d{5,8})\b/i;
    const PHONE_RE = /(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;

    const lines = raw
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 2);

    return lines.map(line => {
      // Detect delimiter: tab → DAT export; pipe; comma; space fallback
      const delim = line.includes("\t") ? "\t" : line.includes("|") ? "|" : line.includes(",") ? "," : null;
      let parts = delim ? line.split(delim).map(p => p.trim()) : [line];

      // Extract structured fields
      const emailMatch = line.match(EMAIL_RE);
      const mcMatch = line.match(MC_RE);
      const phoneMatch = line.match(PHONE_RE);

      // Remove matched tokens from parts to isolate name
      let remaining = line;
      if (emailMatch) remaining = remaining.replace(emailMatch[0], "");
      if (mcMatch) remaining = remaining.replace(mcMatch[0], "");
      if (phoneMatch) remaining = remaining.replace(phoneMatch[0], "");
      if (delim) remaining = remaining.split(delim)[0];

      // Clean up name
      const name = remaining
        .replace(/[|,\t]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (!name || name.length < 2) return null;

      return {
        name,
        email: emailMatch ? emailMatch[0] : undefined,
        mcDot: mcMatch ? `MC${mcMatch[1]}` : undefined,
        phone: phoneMatch ? phoneMatch[0] : undefined,
      } as ParsedImportCarrier;
    }).filter((c): c is ParsedImportCarrier => c !== null);
  }

  /**
   * Parses a raw string of email addresses (comma, space, or newline separated).
   * Returns { valid, invalid } arrays.
   */
  function parseAdHocEmails(raw: string): { valid: string[]; invalid: string[] } {
    const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
    const tokens = raw
      .split(/[\s,;\n]+/)
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length > 0);
    const valid: string[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      if (EMAIL_RE.test(token)) valid.push(token);
      else invalid.push(token);
    }
    return { valid, invalid };
  }

  const adHocParsed = adHocEmailPasteText.trim() ? parseAdHocEmails(adHocEmailPasteText) : { valid: [], invalid: [] };

  // ── Template helpers ─────────────────────────────────────────────────────

  /** Apply a template to the editor, substituting lane-level vars immediately. */
  function applyTemplateToEditor(templateId: string) {
    const tpl = OUTREACH_TEMPLATES.find(t => t.id === templateId);
    if (!tpl) return;
    const laneVars = {
      origin: lane ? formatLaneLocation(lane.origin, lane.originState) : "",
      destination: lane ? formatLaneLocation(lane.destination, lane.destinationState) : "",
      equipmentType: lane?.equipmentType ?? "dry van",
    };
    const body = applyLaneVars(tpl.body, laneVars);
    const subj = applyLaneVars(tpl.subject, laneVars);
    setSharedTemplate(body);
    setSharedSubject(subj);
    setLastAppliedBody(body);
    setLastAppliedSubject(subj);
    setSelectedTemplateId(templateId);
  }

  /** Check whether rep has modified the template content since it was last applied. */
  function isTemplateDirty() {
    // Only considered dirty if we've applied at least one template before
    if (!lastAppliedBody) return false;
    return sharedTemplate !== lastAppliedBody || sharedSubject !== lastAppliedSubject;
  }

  /** Handle rep selecting a new template — shows confirm if current content is dirty. */
  function handleTemplateSelect(templateId: string) {
    if (templateId === selectedTemplateId) return;
    if (isTemplateDirty()) {
      setPendingTemplateId(templateId);
    } else if (templateId === "__ai__") {
      // Clear template to fall back to AI drafting
      setSharedTemplate("");
      setSharedSubject("");
      setLastAppliedBody("");
      setLastAppliedSubject("");
      setSelectedTemplateId("__ai__");
    } else {
      applyTemplateToEditor(templateId);
    }
  }

  function openBulkEditModal(draftIndex: number) {
    const draft = emailDrafts[draftIndex];
    if (!draft) return;
    setBulkEditSubject(draft.subject);
    setBulkEditBody(draft.body);
    setBulkEditSourceIndex(draftIndex);
    setBulkEditOpen(true);
  }

  function handleBulkApproveAndApply() {
    const subjectWithPlaceholder = reverseCarrierName(bulkEditSubject, emailDrafts[bulkEditSourceIndex]?.carrierName ?? "");
    const bodyWithPlaceholder = reverseCarrierName(bulkEditBody, emailDrafts[bulkEditSourceIndex]?.carrierName ?? "");

    setEmailDrafts(prev =>
      prev.map(draft => {
        const isAdHoc = draft.carrierName.startsWith("Ad-hoc:");
        const resolvedName = isAdHoc ? "team" : draft.carrierName;
        return {
          ...draft,
          subject: applyTemplateVars(subjectWithPlaceholder, { carrierName: resolvedName }),
          body: applyTemplateVars(bodyWithPlaceholder, { carrierName: resolvedName }),
        };
      })
    );
    setBulkEditOpen(false);
  }

  function reverseCarrierName(text: string, carrierName: string): string {
    if (!carrierName) return text;
    const cleanName = carrierName.replace(/^Ad-hoc:\s*/, "");
    if (!cleanName || cleanName === "team") return text;
    return text.split(cleanName).join("{{carrierName}}");
  }

  function handleGenerateOutreach() {
    const selected = filteredCarriers.filter(c => selectedCarriers.has(c.carrierId ?? c.carrierName));
    if (selected.length === 0 && adHocParsed.valid.length === 0) {
      toast({ title: "Select at least one carrier or paste email addresses first" });
      return;
    }
    const laneDisplay = lane ? formatLaneDisplay(lane.origin, lane.originState, lane.destination, lane.destinationState) : "";
    const equipment = lane?.equipmentType ?? "dry van";
    // Auto-generated subject/body are only used as last-resort fallbacks (no template)
    const autoSubject = `Lane-Building Opportunity: ${laneDisplay} (${equipment})`;
    const loadRange = formatWeeklyLoadRange(lane?.avgLoadsPerWeek);
    const bareRange = loadRange.replace(/^(usually|around|about)\s+/i, "");
    const autoFallbackBody = `Hey team — checking to see if you've got capacity for ${laneDisplay} (${equipment}). We usually have ${bareRange} on this lane and are looking to line up steady coverage. Does that fit your network? If so, I'd be glad to talk through it.`;

    const effectiveBody = sharedTemplate.trim() || autoFallbackBody;
    const effectiveSubject = sharedSubject.trim() || autoSubject;

    // Build ad-hoc drafts for pasted email addresses ({{carrierName}} → "team")
    const adHocDrafts: EmailDraft[] = adHocParsed.valid.map(email => ({
      carrierId: null,
      carrierName: `Ad-hoc: ${email}`,
      subject: applyTemplateVars(effectiveSubject, { carrierName: "team" }),
      body: applyTemplateVars(effectiveBody, { carrierName: "team" }),
      outreachMode,
      recipientEmail: email,
    }));

    // If a template (or any shared body) is set, use it — no AI drafting
    if (sharedTemplate.trim()) {
      const carrierDrafts: EmailDraft[] = selected.map(c => ({
        carrierId: c.carrierId,
        carrierName: c.carrierName,
        subject: applyTemplateVars(effectiveSubject, { carrierName: c.carrierName }),
        body: applyTemplateVars(effectiveBody, { carrierName: c.carrierName }),
        outreachMode,
      }));
      setEmailDrafts([...carrierDrafts, ...adHocDrafts]);
      setDraftsFromTemplate(true);
      setShowEmails(true);
      setActiveMainTab("message");
      return;
    }

    if (selected.length > 0) {
      // AI-draft for catalog carriers; ad-hoc drafts appended after
      draftEmailsMutation.mutate(
        {
          carrierIds: selected.map(c => c.carrierId),
          carrierNames: selected.map(c => c.carrierName),
          outreachMode,
        },
        {
          onSuccess: (data: { emails: EmailDraft[] }) => {
            setEmailDrafts([...(data.emails ?? []), ...adHocDrafts]);
            setDraftsFromTemplate(false);
            setShowEmails(true);
            setActiveMainTab("message");
          },
        }
      );
    } else {
      // Only ad-hoc emails — show them directly
      setEmailDrafts(adHocDrafts);
      setDraftsFromTemplate(false);
      setShowEmails(true);
      setActiveMainTab("message");
    }
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

  function handleSendOutreach() {
    if (emailDrafts.length === 0) {
      toast({ title: "Generate drafts first before sending" });
      return;
    }
    // Build captured emails map from component state
    const emailsToSave: Record<string, string> = {};
    for (const draft of emailDrafts) {
      const key = draft.carrierId ?? draft.carrierName;
      if (capturedEmails[key]?.trim()) emailsToSave[key] = capturedEmails[key].trim();
    }
    setSendOverallStatus("sending");
    setDraftSendStatus(Object.fromEntries(emailDrafts.map((_, i) => [i, "sending"])));
    sendOutreachMutation.mutate({
      emailDrafts,
      outreachMode,
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
    return formatLaneDisplay(l.origin, l.originState, l.destination, l.destinationState);
  }

  const contactedCount = lane?.carriersContactedCount ?? 0;
  const progressPct = Math.min(100, (contactedCount / completionThreshold) * 100);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl bg-background border-border text-foreground overflow-hidden p-0 flex flex-col"
        data-testid="carrier-outreach-panel"
      >
        {/* ── COMPACT HEADER ─────────────────────────────────────────────── */}
        <SheetHeader className="px-5 pt-4 pb-3 border-b border-border shrink-0">
          {/* Title row */}
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded bg-amber-500/20 flex items-center justify-center shrink-0">
              <Truck className="w-3.5 h-3.5 text-amber-400" />
            </div>
            <div className="flex-1 min-w-0">
              <SheetTitle className="text-sm font-semibold text-foreground leading-tight">
                {laneLoading ? "Loading…" : lane ? laneLabel(lane) : "Lock In Capacity"}
              </SheetTitle>
              {lane && (
                <SheetDescription className="text-[10px] text-muted-foreground mt-0 leading-tight">
                  {lane.equipmentType ?? "Any Equipment"}
                  {lane.dropTrailerShipper && (
                    <span className="ml-2 inline-flex items-center rounded bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-medium text-blue-400" data-testid="badge-drop-shipper">Drop @ Shipper</span>
                  )}
                  {lane.dropTrailerReceiver && (
                    <span className="ml-1 inline-flex items-center rounded bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-medium text-blue-400" data-testid="badge-drop-receiver">Drop @ Receiver</span>
                  )}
                  {lane.eligibilityConfidence && (
                    <span className={`ml-2 capitalize ${
                      lane.eligibilityConfidence === "high" ? "text-emerald-400" :
                      lane.eligibilityConfidence === "medium" ? "text-amber-400" : "text-muted-foreground"
                    }`}>· {lane.eligibilityConfidence} confidence</span>
                  )}
                </SheetDescription>
              )}
            </div>
          </div>

          {/* Compact stat strip + progress */}
          {lane && (
            <div className="mt-2">
              <div className="flex items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground flex-wrap">
                <span>Avg <span className="text-foreground font-medium">{lane.avgLoadsPerWeek ?? "—"}</span>/wk</span>
                <span className="text-muted-foreground/30">·</span>
                <span>Active <span className="text-foreground font-medium">{lane.weeksActive ?? "—"}/{lane.lookbackWeeks ?? 4}</span> wks</span>
                <span className="text-muted-foreground/30">·</span>
                <span>Score <span className="text-foreground font-medium">{lane.laneScore ?? "—"}</span></span>
                <span className="text-muted-foreground/30">·</span>
                <span>Contacted <span className={`font-medium ${contactedCount >= completionThreshold ? "text-emerald-400" : "text-foreground"}`}>{contactedCount}/{completionThreshold}</span></span>
                {laneDetail && laneDetail.totalBenchCount > 0 && (
                  <>
                    <span className="text-muted-foreground/30">·</span>
                    <span data-testid="stat-bench-count">Bench <span className="text-foreground font-medium">{laneDetail.totalBenchCount}</span></span>
                  </>
                )}
                {laneDetail?.replySummary && laneDetail.replySummary.totalReplied > 0 && (
                  <>
                    <span className="text-muted-foreground/30">·</span>
                    <span
                      className={laneDetail.replySummary.hotCount > 0 ? "text-green-400 font-medium" : ""}
                      data-testid="stat-replies"
                    >
                      {laneDetail.replySummary.hotCount > 0 && "⚡ "}{laneDetail.replySummary.totalReplied} repl{laneDetail.replySummary.totalReplied === 1 ? "y" : "ies"}
                      {laneDetail.replySummary.hotCount > 0 && ` · ${laneDetail.replySummary.hotCount} hot`}
                    </span>
                  </>
                )}
              </div>
              <div className="mt-1.5 h-1 rounded-full bg-muted/40">
                <div
                  className="h-1 rounded-full bg-amber-400 transition-all"
                  style={{ width: `${progressPct}%` }}
                  data-testid="outreach-progress-bar"
                />
              </div>
            </div>
          )}

          {/* Owner / Overseer chips + outreach mode */}
          {lane && (
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {/* Unassigned state */}
              {!lane.ownerUserId && isManager && (
                <div className="flex items-center gap-1">
                  <span className="text-[9px] text-muted-foreground italic">No owner</span>
                  {currentUser && (
                    <button
                      onClick={() => assignLaneMutation.mutate(currentUser.id)}
                      disabled={assignLaneMutation.isPending}
                      className="text-[9px] px-1.5 py-0.5 rounded-full border border-blue-400/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 transition-colors"
                      data-testid="btn-assign-to-me"
                    >
                      Assign to me
                    </button>
                  )}
                  {isDirectorOrAdmin && (
                    <Select onValueChange={v => assignLaneMutation.mutate(v)}>
                      <SelectTrigger className="h-5 w-auto text-[9px] bg-muted/20 border-border text-muted-foreground" data-testid="btn-assign-select">
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
                const canUnassign = isManager || lane.ownerUserId === currentUser?.id;
                return (
                  <div className="flex items-center gap-1">
                    <div className="flex items-center gap-1 bg-muted/20 border border-border rounded-full px-1.5 py-0.5" data-testid="chip-lane-owner">
                      <User className="w-2.5 h-2.5 text-blue-300" />
                      <span className="text-[9px] text-foreground/70">{owner?.name ?? "Owner"}</span>
                      {isDirectorOrAdmin && (
                        <Select value={lane.ownerUserId} onValueChange={v => reassignMutation.mutate({ ownerUserId: v })}>
                          <SelectTrigger className="h-4 w-4 p-0 border-0 bg-transparent text-muted-foreground hover:text-foreground/80" data-testid="btn-reassign-owner">
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
                    {canUnassign && (
                      <button
                        onClick={() => assignLaneMutation.mutate(null)}
                        disabled={assignLaneMutation.isPending}
                        className="text-[9px] p-0.5 rounded border border-red-400/20 bg-red-500/8 text-red-300 hover:bg-red-500/15 transition-colors disabled:opacity-50"
                        data-testid="btn-unassign-lane"
                        title="Unassign lane"
                      >
                        <UserX className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>
                );
              })()}
              {lane.overseerUserId && lane.overseerUserId !== lane.ownerUserId && (() => {
                const overseer = teamMembers.find(m => m.id === lane.overseerUserId);
                return (
                  <div className="flex items-center gap-1 bg-muted/20 border border-border rounded-full px-1.5 py-0.5" data-testid="chip-lane-overseer">
                    <UserCheck className="w-2.5 h-2.5 text-violet-300" />
                    <span className="text-[9px] text-foreground/70">{overseer?.name ?? "Overseer"}</span>
                    {isDirectorOrAdmin && (
                      <Select value={lane.overseerUserId ?? ""} onValueChange={v => reassignMutation.mutate({ overseerUserId: v })}>
                        <SelectTrigger className="h-4 w-4 p-0 border-0 bg-transparent text-muted-foreground hover:text-foreground/80" data-testid="btn-reassign-overseer">
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
              {/* Outreach mode — compact, pushed right */}
              <div className="ml-auto">
                <Select value={outreachMode} onValueChange={(v: "lane_building" | "immediate_plus_lane") => setOutreachMode(v)}>
                  <SelectTrigger className="h-6 w-auto text-[9px] bg-muted/20 border-border text-foreground/70 pr-1.5" data-testid="outreach-mode-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border text-foreground">
                    <SelectItem value="lane_building" className="text-xs">Lane-Building</SelectItem>
                    <SelectItem value="immediate_plus_lane" className="text-xs">Immediate + Lane</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </SheetHeader>

        {/* ── BODY ───────────────────────────────────────────────────────── */}
        <div className="flex flex-col flex-1 overflow-hidden">

          {/* Main tab navigation */}
          <div className="flex border-b border-border bg-muted/5 px-4 shrink-0">
            {(["carriers", "message", "followup", "history"] as const).map(tab => {
              const labels: Record<string, string> = {
                carriers: "Carriers",
                message: "Message",
                followup: "Follow-up",
                history: "History",
              };
              return (
                <button
                  key={tab}
                  onClick={() => setActiveMainTab(tab)}
                  className={`relative text-xs py-2.5 px-3 border-b-2 transition-colors shrink-0 ${
                    activeMainTab === tab
                      ? "border-amber-400 text-foreground font-medium"
                      : "border-transparent text-muted-foreground hover:text-foreground/70"
                  }`}
                  data-testid={`tab-${tab}`}
                >
                  {labels[tab]}
                  {tab === "message" && selectedCarriers.size > 0 && (
                    <span className="ml-1 inline-flex items-center justify-center min-w-[16px] h-4 px-0.5 text-[9px] rounded-full bg-amber-500/20 text-amber-300 font-medium">
                      {selectedCarriers.size}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* ══════════════════════════════════════════════════════════════ */}
          {/* CARRIERS TAB                                                  */}
          {/* ══════════════════════════════════════════════════════════════ */}
          {activeMainTab === "carriers" && (
            <div className="flex flex-col flex-1 overflow-hidden">
              {/* Sub-tab nav: Ranked | Bench | Import */}
              <div className="flex border-b border-border/40 bg-background px-4 shrink-0">
                {(["ranked", "bench", "import"] as const).map(st => {
                  const subLabels: Record<string, string> = {
                    ranked: filteredCarriers.length > 0 ? `Ranked (${filteredCarriers.length})` : "Ranked",
                    bench: bench.length > 0 ? `Bench (${bench.length})` : "Bench",
                    import: "Import",
                  };
                  return (
                    <button
                      key={st}
                      onClick={() => setActiveCarriersSubTab(st)}
                      className={`text-[11px] py-1.5 px-3 border-b-2 transition-colors ${
                        activeCarriersSubTab === st
                          ? "border-foreground/50 text-foreground/90 font-medium"
                          : "border-transparent text-muted-foreground hover:text-foreground/60"
                      }`}
                      data-testid={`subtab-${st}`}
                    >
                      {subLabels[st]}
                    </button>
                  );
                })}
              </div>

              {/* ── RANKED SUB-TAB ─────────────────────────────────────── */}
              {activeCarriersSubTab === "ranked" && (
                <div className="flex-1 px-5 pt-3 pb-24 overflow-y-auto" data-testid="tab-carriers">

                  {/* Stable Coverage inline section */}
                  {coverageData?.profile && (() => {
                    const profile = coverageData.profile;
                    const coverCarriers = coverageData.carriers ?? [];
                    const effectiveStatus = profile.manualOverrideStatus ?? profile.coverageStatus;
                    const isStable = effectiveStatus === "stable";
                    const isWatch = effectiveStatus === "watch";
                    const coverShare = profile.topCarrierCoverageShare ? (parseFloat(profile.topCarrierCoverageShare) * 100).toFixed(0) : null;
                    return (
                      <div className={`mb-3 rounded-lg border overflow-hidden ${
                        isStable ? "border-emerald-500/30 bg-emerald-500/5" :
                        isWatch  ? "border-amber-500/20 bg-amber-500/5" :
                                   "border-border bg-muted/10"
                      }`} data-testid="coverage-section-inline">
                        {/* Coverage header row */}
                        <div className="flex items-center justify-between gap-2 px-3 py-2">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {isStable ? <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" /> :
                             isWatch  ? <TrendingUp className="w-3.5 h-3.5 text-amber-400 shrink-0" /> :
                                        <ShieldAlert className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                            <span className={`text-[11px] font-semibold ${
                              isStable ? "text-emerald-400" : isWatch ? "text-amber-400" : "text-muted-foreground"
                            }`}>
                              {isStable ? "Stable Coverage" : isWatch ? "Coverage Watch" : "No Carrier History"}
                              {profile.manualOverrideStatus && <span className="ml-1 text-[9px] text-violet-400 font-normal">(override)</span>}
                            </span>
                            {coverCarriers.length > 0 && (
                              <span className="text-[9px] text-muted-foreground">{coverCarriers.length} incumbent{coverCarriers.length !== 1 ? "s" : ""} · {profile.sampleSize} loads</span>
                            )}
                            {profile.broadenSearchActive && (
                              <Badge variant="outline" className="text-[9px] py-0 px-1 border-blue-500/30 text-blue-400">
                                <Search className="w-2.5 h-2.5 mr-0.5" /> Broaden on
                              </Badge>
                            )}
                          </div>
                          <button
                            onClick={() => setCoverageExpanded(v => !v)}
                            className="text-[9px] text-muted-foreground hover:text-foreground/60 flex items-center gap-0.5 shrink-0"
                          >
                            {coverageExpanded ? "Less" : "Details"}
                            {coverageExpanded ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
                          </button>
                        </div>
                        {/* Incumbent carrier chips */}
                        {coverCarriers.length > 0 && (
                          <div className="flex flex-wrap gap-1 px-3 pb-2">
                            {coverCarriers.map((c, i) => (
                              <span key={i} className={`text-[9px] px-1.5 py-0.5 rounded border ${
                                c.isCurrentPrimary
                                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                                  : "border-border bg-muted/10 text-muted-foreground"
                              }`} data-testid={`coverage-inline-carrier-${i}`}>
                                #{c.incumbentRank} {c.carrierName}
                              </span>
                            ))}
                          </div>
                        )}
                        {/* Action buttons */}
                        <div className="flex flex-col gap-1.5 px-3 pb-2">
                          {!isStable && (
                            <p className="text-[9px] text-muted-foreground italic">
                              {effectiveStatus === "unstable"
                                ? "No recurring carrier found in TMS data — you can still contact carriers below. Use these options to update the status if you know this lane is covered."
                                : "Coverage is thin. Contact carriers below, or use these options to update the lane status."}
                            </p>
                          )}
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {isStable && !profile.broadenSearchActive && (
                              <Button size="sm" variant="outline" className="h-6 text-[9px] px-2 border-emerald-500/30 text-emerald-400" data-testid="button-use-incumbent-flow" title="Incumbent flow active">
                                <ShieldCheck className="w-2.5 h-2.5 mr-1" /> Incumbent Flow Active
                              </Button>
                            )}
                            {!isStable && (
                              <Button size="sm" variant="outline"
                                className="h-6 text-[9px] px-2 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                                data-testid="button-confirm-stable-inline"
                                onClick={async () => {
                                  try {
                                    await apiRequest("POST", `/api/lanes/${laneId}/coverage-profile/override`, { status: "stable", reason: "Manually confirmed stable by user" });
                                    await refetchCoverage();
                                    toast({ title: "Coverage marked as stable" });
                                  } catch { toast({ title: "Failed to confirm stable status", variant: "destructive" }); }
                                }}
                              >
                                <ShieldCheck className="w-2.5 h-2.5 mr-1" /> Mark as Covered
                              </Button>
                            )}
                            <Button size="sm" variant="outline"
                              className={`h-6 text-[9px] px-2 ${profile.broadenSearchActive ? "border-blue-500/40 text-blue-400 hover:bg-blue-500/10" : "border-border text-muted-foreground hover:bg-muted/40"}`}
                              data-testid="button-broaden-search-inline"
                              onClick={async () => {
                                try {
                                  await apiRequest("POST", `/api/lanes/${laneId}/coverage-profile/broaden`, { active: !profile.broadenSearchActive });
                                  await refetchCoverage();
                                  toast({ title: profile.broadenSearchActive ? "Broaden search disabled" : "Showing all carriers" });
                                } catch { toast({ title: "Failed to toggle broaden search", variant: "destructive" }); }
                              }}
                              title={profile.broadenSearchActive ? "Currently showing all carriers in the region — click to revert to historical matches only" : "Expand carrier suggestions beyond TMS history to include all regional carriers"}
                            >
                              <Search className="w-2.5 h-2.5 mr-1" /> {profile.broadenSearchActive ? "Showing All Carriers" : "Show More Carriers"}
                            </Button>
                            {isStable && (
                              <Button size="sm" variant="outline"
                                className="h-6 text-[9px] px-2 border-border text-muted-foreground hover:text-red-400 hover:border-red-400/30"
                                data-testid="button-remove-stable-status"
                                onClick={async () => {
                                  try {
                                    await apiRequest("POST", `/api/lanes/${laneId}/coverage-profile/override`, { status: "watch", reason: "Stable status removed by user" });
                                    await refetchCoverage();
                                    toast({ title: "Stable status removed" });
                                  } catch { toast({ title: "Failed to remove stable status", variant: "destructive" }); }
                                }}
                              >
                                Remove Stable
                              </Button>
                            )}
                          </div>
                        </div>
                        {/* Expanded coverage detail */}
                        {coverageExpanded && (
                          <div className="px-3 pb-3 pt-1 border-t border-border/40 bg-muted/5">
                            {/* Stats grid */}
                            <div className="grid grid-cols-3 gap-3 mb-3">
                              <div className="flex flex-col">
                                <span className="text-[9px] text-muted-foreground uppercase tracking-wide">Sample Size</span>
                                <span className="text-base font-bold text-foreground" data-testid="coverage-sample-size">{profile.sampleSize}</span>
                                <span className="text-[9px] text-muted-foreground">total loads</span>
                              </div>
                              <div className="flex flex-col">
                                <span className="text-[9px] text-muted-foreground uppercase tracking-wide">Qualified</span>
                                <span className="text-base font-bold text-foreground" data-testid="coverage-carrier-count">{profile.qualifiedCarrierCount}</span>
                                <span className="text-[9px] text-muted-foreground">carriers w/ history</span>
                              </div>
                              {coverShare && (
                                <div className="flex flex-col">
                                  <span className="text-[9px] text-muted-foreground uppercase tracking-wide">Top Share</span>
                                  <span className="text-base font-bold text-foreground">{coverShare}%</span>
                                  <span className="text-[9px] text-muted-foreground">of recent loads</span>
                                </div>
                              )}
                            </div>
                            {/* Override controls */}
                            <div className="flex gap-1.5 mb-2">
                              {(["stable", "watch", "unstable"] as const).map(s => (
                                <Button key={s} size="sm" variant="outline"
                                  className={`flex-1 text-[10px] ${
                                    s === "stable" ? "border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10" :
                                    s === "watch"  ? "border-amber-500/30 text-amber-400 hover:bg-amber-500/10" :
                                                    "border-border text-muted-foreground hover:bg-muted/40"
                                  } ${effectiveStatus === s ? "bg-muted/40 font-bold" : ""}`}
                                  data-testid={`button-override-${s}`}
                                  onClick={async () => {
                                    if (effectiveStatus === s) return;
                                    try {
                                      await apiRequest("POST", `/api/lanes/${laneId}/coverage-profile/override`, { status: s, reason: `Manually set to ${s} by user` });
                                      await refetchCoverage();
                                      toast({ title: `Coverage set to ${s}` });
                                    } catch { toast({ title: "Failed to set override", variant: "destructive" }); }
                                  }}
                                >
                                  {s.charAt(0).toUpperCase() + s.slice(1)}
                                </Button>
                              ))}
                            </div>
                            {/* Incumbent detail list */}
                            {coverCarriers.length > 0 && (
                              <div className="flex flex-col gap-1.5">
                                <p className="text-[9px] text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                                  <Star className="w-2.5 h-2.5 text-amber-400" /> Incumbent Carriers
                                </p>
                                {coverCarriers.map((c, idx) => {
                                  const pct = c.coverageShare ? (parseFloat(c.coverageShare) * 100).toFixed(0) : null;
                                  return (
                                    <div key={c.id ?? idx} className="flex items-center justify-between gap-2 bg-muted/10 border border-border rounded px-2 py-1.5" data-testid={`coverage-carrier-${idx}`}>
                                      <div className="flex items-center gap-1.5">
                                        <span className={`text-[9px] font-bold rounded px-1 ${c.incumbentRank === 1 ? "bg-amber-400/20 text-amber-400" : "bg-muted/30 text-muted-foreground"}`}>#{c.incumbentRank}</span>
                                        <span className="text-[10px] font-medium text-foreground" data-testid={`coverage-carrier-name-${idx}`}>{c.carrierName}</span>
                                        {c.isCurrentPrimary && <Badge variant="outline" className="text-[9px] py-0 px-1 border-emerald-500/40 text-emerald-400">Primary</Badge>}
                                      </div>
                                      <div className="flex items-center gap-2 text-[9px] text-muted-foreground">
                                        {pct && <span>{pct}%</span>}
                                        <span>{c.successfulLoadCount} loads</span>
                                        {c.lastUsedAt && <span>Last {new Date(c.lastUsedAt).toLocaleDateString()}</span>}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            {profile.manualOverrideReason && (
                              <p className="mt-2 text-[9px] text-muted-foreground italic">Override reason: {profile.manualOverrideReason}</p>
                            )}
                            {profile.updatedAt && (
                              <p className="text-[9px] text-muted-foreground mt-0.5">Updated {new Date(profile.updatedAt).toLocaleString()}</p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* ── Email Template picker — always visible ── */}
                  <div className="mb-3 rounded-lg border border-border bg-muted/10 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Mail className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <p className="text-[11px] font-semibold text-foreground/80 shrink-0">Email Template</p>
                      <Select value={selectedTemplateId} onValueChange={handleTemplateSelect}>
                        <SelectTrigger className="flex-1 h-7 text-xs bg-muted/20 border-border text-foreground/80" data-testid="template-selector-carriers">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border text-foreground">
                          {OUTREACH_TEMPLATES.map(t => (
                            <SelectItem key={t.id} value={t.id} className="text-xs">{t.label}</SelectItem>
                          ))}
                          <SelectItem value="__ai__" className="text-xs text-blue-400">AI Draft (let AI write it)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {pendingTemplateId && (
                      <div className="mt-2 flex items-center gap-2 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2">
                        <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        <p className="text-[11px] text-amber-300 flex-1">Switching templates will replace your current edits. Continue?</p>
                        <button
                          onClick={() => {
                            if (pendingTemplateId === "__ai__") {
                              setSharedTemplate(""); setSharedSubject(""); setLastAppliedBody(""); setLastAppliedSubject(""); setSelectedTemplateId("__ai__");
                            } else {
                              applyTemplateToEditor(pendingTemplateId);
                            }
                            setPendingTemplateId(null);
                          }}
                          className="text-[10px] px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/40 text-amber-300 hover:bg-amber-500/30 transition-colors"
                        >
                          Replace
                        </button>
                        <button
                          onClick={() => setPendingTemplateId(null)}
                          className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-muted/20 transition-colors"
                        >
                          Keep edits
                        </button>
                      </div>
                    )}
                  </div>

                  {/* ── Filter row: Sort + primary chips + Refine toggle ── */}
                  <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                    <Select value={sortOption} onValueChange={v => { setSortOption(v); setCurrentPage(1); }}>
                      <SelectTrigger className="h-7 w-auto text-[10px] bg-muted/20 border-border text-foreground/70 min-w-[130px]" data-testid="select-sort-carriers">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-card border-border text-foreground">
                        <SelectItem value="recommended" className="text-xs">Recommended</SelectItem>
                        <SelectItem value="loadsDesc" className="text-xs">Exact Loads ↓</SelectItem>
                        <SelectItem value="recency" className="text-xs">Recency</SelectItem>
                        <SelectItem value="customerHistory" className="text-xs">Customer History</SelectItem>
                        <SelectItem value="outreachReadiness" className="text-xs">Outreach Readiness</SelectItem>
                        <SelectItem value="alpha" className="text-xs">A–Z</SelectItem>
                      </SelectContent>
                    </Select>
                    {/* Primary filters always visible */}
                    <button
                      onClick={() => { setFilterExactOnly(v => !v); setCurrentPage(1); }}
                      className={`text-[10px] px-2 py-1 rounded-full border transition-colors ${
                        filterExactOnly ? "bg-amber-500/20 border-amber-400/40 text-amber-300" : "bg-muted/10 border-border text-muted-foreground hover:border-muted-foreground/30"
                      }`}
                      data-testid="filter-exact-only"
                    >
                      Exact history
                    </button>
                    <button
                      onClick={() => { setFilterHasEmail(v => !v); setCurrentPage(1); }}
                      className={`text-[10px] px-2 py-1 rounded-full border transition-colors ${
                        filterHasEmail ? "bg-emerald-500/20 border-emerald-400/40 text-emerald-300" : "bg-muted/10 border-border text-muted-foreground hover:border-muted-foreground/30"
                      }`}
                      data-testid="filter-has-email"
                    >
                      Has email
                    </button>
                    {/* Refine toggle */}
                    {(() => {
                      const refineActive = filterNotRecentlyContacted || activeOnly || !filterIncludeNewProspects || excludeServiceFlags;
                      const refineCount = [filterNotRecentlyContacted, activeOnly, !filterIncludeNewProspects, excludeServiceFlags].filter(Boolean).length;
                      return (
                        <button
                          onClick={() => setShowRefineFilters(v => !v)}
                          className={`text-[10px] px-2 py-1 rounded-full border transition-colors flex items-center gap-1 ${
                            refineActive
                              ? "bg-violet-500/20 border-violet-400/40 text-violet-300"
                              : showRefineFilters
                                ? "bg-muted/30 border-muted-foreground/30 text-foreground/70"
                                : "bg-muted/10 border-border text-muted-foreground hover:border-muted-foreground/30"
                          }`}
                          data-testid="toggle-refine-filters"
                        >
                          Refine{refineCount > 0 ? ` (${refineCount})` : ""}
                          {showRefineFilters ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
                        </button>
                      );
                    })()}
                    {totalCount > 0 && (
                      <span className="text-[10px] text-muted-foreground ml-auto" data-testid="text-results-count">
                        {filteredCarriers.length}/{totalCount}
                      </span>
                    )}
                  </div>

                  {/* Refine panel (collapsible) */}
                  {showRefineFilters && (
                    <div className="mb-3 p-2.5 rounded-lg border border-border bg-muted/10 flex flex-wrap gap-1.5 items-center">
                      <button
                        onClick={() => { setFilterNotRecentlyContacted(v => !v); setCurrentPage(1); }}
                        className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${filterNotRecentlyContacted ? "bg-violet-500/20 border-violet-400/40 text-violet-300" : "bg-muted/10 border-border text-muted-foreground"}`}
                        data-testid="filter-not-recently-contacted"
                      >
                        Not recent
                      </button>
                      <button
                        onClick={() => { setActiveOnly(v => !v); setCurrentPage(1); }}
                        className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${activeOnly ? "bg-blue-500/20 border-blue-400/40 text-blue-300" : "bg-muted/10 border-border text-muted-foreground"}`}
                        data-testid="toggle-active-90-days"
                      >
                        Active (90d)
                      </button>
                      <button
                        onClick={() => { setFilterIncludeNewProspects(v => !v); setCurrentPage(1); }}
                        className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${!filterIncludeNewProspects ? "bg-muted/50 border-border text-foreground" : "bg-muted/10 border-border text-muted-foreground"}`}
                        data-testid="filter-include-new-prospects"
                      >
                        {filterIncludeNewProspects ? "Incl. prospects" : "No prospects"}
                      </button>
                      <button
                        onClick={() => setExcludeServiceFlags(v => !v)}
                        className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${excludeServiceFlags ? "bg-red-500/20 border-red-400/40 text-red-300" : "bg-muted/10 border-border text-muted-foreground"}`}
                        data-testid="toggle-exclude-service-flags"
                      >
                        Excl. flagged
                      </button>
                      <Select value={String(pageSize)} onValueChange={v => { setPageSize(Number(v)); setCurrentPage(1); }}>
                        <SelectTrigger className="h-6 w-auto text-[10px] bg-muted/20 border-border text-foreground/70" data-testid="select-page-size">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border text-foreground">
                          <SelectItem value="20" className="text-xs">Show 20</SelectItem>
                          <SelectItem value="50" className="text-xs">Show 50</SelectItem>
                          <SelectItem value="100" className="text-xs">Show 100</SelectItem>
                          <SelectItem value="0" className="text-xs">Show All</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Bulk selection controls */}
                  {filteredCarriers.length > 0 && (
                    <div className="flex items-center gap-1.5 mb-3 flex-wrap">
                      <button
                        onClick={selectAllFiltered}
                        className="text-[11px] px-3 py-1 rounded border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 font-semibold transition-colors flex items-center gap-1"
                        data-testid="btn-select-all-filtered"
                      >
                        <CheckCircle2 className="w-3 h-3" /> Select All Carriers
                      </button>
                      {isHighFrequencyLane && (
                        <button
                          onClick={() => selectTopN(30)}
                          className="text-[10px] px-2 py-0.5 rounded-full border border-orange-500/40 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 transition-colors font-medium"
                          data-testid="btn-select-top-30-hf"
                          title="High-frequency lane: select top 30 carriers for bulk outreach"
                        >
                          Top 30 (HF)
                        </button>
                      )}
                      <button onClick={() => selectTopN(20)} className="text-[10px] px-2 py-0.5 rounded-full border border-border bg-muted/20 text-muted-foreground hover:text-foreground/80 transition-colors" data-testid="btn-select-top-20">
                        Top 20
                      </button>
                      <button onClick={() => selectTopN(50)} className="text-[10px] px-2 py-0.5 rounded-full border border-border bg-muted/20 text-muted-foreground hover:text-foreground/80 transition-colors" data-testid="btn-select-top-50">
                        Top 50
                      </button>
                      {selectedCarriers.size > 0 && (
                        <>
                          <button onClick={clearSelection} className="text-[10px] px-2 py-0.5 rounded-full border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors" data-testid="btn-clear-selection">
                            Clear ({selectedCarriers.size})
                          </button>
                          <span className="text-[10px] text-amber-300 font-medium">{selectedCarriers.size} selected</span>
                        </>
                      )}
                    </div>
                  )}

                  {/* Loading state */}
                  {suggestionsLoading && (
                    <div className="flex flex-col gap-2">
                      <p className="text-[10px] text-muted-foreground text-center py-1 animate-pulse">Loading carrier suggestions…</p>
                      {[1,2,3,4,5].map(i => (
                        <div key={i} className="h-16 rounded-lg bg-muted/20 border border-border animate-pulse" />
                      ))}
                    </div>
                  )}

                  {/* Error state */}
                  {suggestionsError && !suggestionsLoading && (
                    <div className="text-center py-8">
                      <div className="w-10 h-10 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center mx-auto mb-3">
                        <AlertTriangle className="w-5 h-5 text-red-400" />
                      </div>
                      <p className="text-xs text-muted-foreground mb-1">
                        {(suggestionsErrorObj as Error)?.message || "Failed to load carrier suggestions"}
                      </p>
                      <button
                        onClick={() => refetchSuggestions()}
                        className="text-xs text-amber-400 hover:text-amber-300 underline mt-2"
                        data-testid="btn-retry-suggestions"
                      >
                        Try again
                      </button>
                    </div>
                  )}

                  {/* Empty state */}
                  {!suggestionsLoading && !suggestionsError && filteredCarriers.length === 0 && (
                    <div className="text-center py-8">
                      <div className="w-10 h-10 rounded-full bg-muted/20 border border-border flex items-center justify-center mx-auto mb-3">
                        <Truck className="w-5 h-5 text-muted-foreground" />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {rankedCarriers.length === 0
                          ? "No carriers in catalog yet. Add carriers to get ranked suggestions."
                          : "No carriers match the active filters."}
                      </p>
                    </div>
                  )}

                  {/* Historical Carriers Callout */}
                  {!suggestionsLoading && historicalCarriers.length > 0 && (
                    <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 overflow-hidden" data-testid="historical-carriers-callout">
                      <button
                        className="w-full flex items-center justify-between px-3 py-2 text-left"
                        onClick={() => setHistoricalSectionCollapsed(v => !v)}
                      >
                        <div className="flex items-center gap-2">
                          <History className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                          <span className="text-[11px] font-semibold text-amber-300">
                            {historicalCarriers.length} Historical Carrier{historicalCarriers.length !== 1 ? "s" : ""} — Not in Catalog
                          </span>
                        </div>
                        {historicalSectionCollapsed ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronUp className="w-3 h-3 text-muted-foreground" />}
                      </button>
                      {!historicalSectionCollapsed && (
                        <div className="px-3 pb-3 flex flex-col gap-1.5">
                          <p className="text-[9px] text-amber-200/60 mb-1">These carriers ran this exact lane but are not in your catalog. Add them to enable outreach.</p>
                          {historicalCarriers.map((c, i) => (
                            <div key={c.carrierName} className="flex items-center justify-between gap-2 bg-muted/10 border border-border rounded px-2 py-1.5">
                              <div className="flex-1 min-w-0">
                                <p className="text-xs text-foreground font-medium truncate">{c.carrierName}</p>
                                <p className="text-[9px] text-muted-foreground">{c.loadsOnLane} loads{c.lastUsedMonth ? ` · last ${c.lastUsedMonth}` : ""}</p>
                              </div>
                              <a href="/admin/carriers" className="shrink-0 text-[9px] px-1.5 py-0.5 rounded border border-amber-400/30 text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 flex items-center gap-0.5 transition-colors" data-testid={`btn-add-to-catalog-${i}`}>
                                <Plus className="w-2.5 h-2.5" /> Add to Catalog
                              </a>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Carrier List — improved cards ── */}
                  <div className="flex flex-col gap-2">
                    {filteredCarriers.map((c, idx) => {
                      const key = c.carrierId ?? c.carrierName;
                      const isSelected = selectedCarriers.has(key);
                      const suppressions = c.suppressionReasons ?? [];

                      // Tier badge config (locked ranking tiers)
                      const tierConfig: Record<string, { label: string; color: string }> = {
                        exact:      { label: "Exact Match",    color: "border-amber-500/50 text-amber-300 bg-amber-500/10" },
                        nearby:     { label: "Nearby Lane",    color: "border-blue-500/40 text-blue-300 bg-blue-500/10" },
                        state_pair: { label: "Same Corridor",  color: "border-violet-500/40 text-violet-300 bg-violet-500/10" },
                        similar:    { label: "Similar Lane",   color: "border-indigo-500/40 text-indigo-300 bg-indigo-500/10" },
                        region:     { label: "Region Match",   color: "border-border text-muted-foreground bg-muted/10" },
                        none:       { label: "No History",     color: "border-border/60 text-muted-foreground/60 bg-muted/5" },
                      };
                      const tier = tierConfig[c.historyMatch] ?? tierConfig.none;

                      // Concise signal tags
                      const signals: string[] = [];
                      if (c.historyMatch === "exact" && c.loadsOnLane > 0) signals.push(`${c.loadsOnLane} exact load${c.loadsOnLane !== 1 ? "s" : ""}`);
                      else if (c.historyMatch === "nearby" && c.loadsOnLane > 0) signals.push(`${c.loadsOnLane} nearby load${c.loadsOnLane !== 1 ? "s" : ""}`);
                      else if (c.historyMatch === "state_pair" && c.loadsOnLane > 0) signals.push(`${c.loadsOnLane} corridor load${c.loadsOnLane !== 1 ? "s" : ""}`);
                      if (c.lastUsedMonth) signals.push(`Last ${c.lastUsedMonth}`);
                      if (c.primaryEmail || c.backupEmail || capturedEmails[key]) signals.push("Has email");
                      if (c.whyThisCarrier?.claimedLaneMatch) signals.push("Claimed lane");
                      if (c.whyThisCarrier?.priorPositiveOutreach) signals.push("Prior positive");
                      if (c.hasMarketNbaBoost || c.whyThisCarrier?.hasMarketNbaBoost) signals.push("Market signal ↑");

                      return (
                        <div key={key} className="flex flex-col">
                          <button
                            onClick={() => toggleCarrier(c)}
                            className={`text-left p-3 rounded-lg border transition-all ${
                              isSelected
                                ? "bg-amber-500/10 border-amber-500/30 shadow-sm"
                                : "bg-muted/10 border-border hover:bg-muted/20"
                            }`}
                            data-testid={`carrier-suggestion-${idx}`}
                          >
                            <div className="flex items-start gap-3">
                              {/* Selection checkbox */}
                              <div className={`mt-0.5 w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors ${
                                isSelected ? "border-amber-400 bg-amber-500/20" : "border-border bg-muted/20"
                              }`}>
                                {isSelected && <CheckCircle2 className="w-3 h-3 text-amber-400" />}
                              </div>
                              {/* Main content */}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                                  {/*
                                    Task #633 — wrap the carrier name in the
                                    shared "why this carrier" popover. Hover on
                                    desktop / tap on mobile.
                                  */}
                                  <CarrierReasonsPopover
                                    carrierName={c.carrierName}
                                    reasons={c.reasons ?? []}
                                    suppressionReasons={c.suppressionReasons ?? []}
                                    testId={`trigger-reasons-${idx}`}
                                  >
                                    <span
                                      className="text-xs font-semibold text-foreground cursor-help underline-offset-2 decoration-dotted hover:underline"
                                      data-testid={`text-carrier-name-${idx}`}
                                    >
                                      {c.carrierName}
                                    </span>
                                  </CarrierReasonsPopover>
                                  {c.mcDot && (
                                    <span className="text-[9px] px-1 py-0 rounded border border-border text-muted-foreground bg-muted/20 font-mono" title="MC Number" data-testid={`text-mc-number-${idx}`}>
                                      MC {c.mcDot.replace(/^MC[-#\s]?/i, "")}
                                    </span>
                                  )}
                                </div>
                                {/* Tier badge + signals */}
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  {/* Task #632 — Bench tier-0 outranks even `exact`; render
                                      the bench badge BEFORE the history-tier badge so reps
                                      see "Bench Nx wins" first. Tooltip explains the source. */}
                                  {c.bench && (c.benchWins ?? 0) > 0 && (
                                    <span
                                      className="text-[9px] px-1.5 py-0.5 rounded border font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40"
                                      title={`replied yes ${c.benchWins}x in last 90d`}
                                      data-testid={`badge-bench-${idx}`}
                                    >
                                      Bench ({c.benchWins}x wins)
                                    </span>
                                  )}
                                  <span className={`text-[9px] px-1.5 py-0.5 rounded border font-medium ${tier.color}`}>
                                    {tier.label}
                                  </span>
                                  {signals.length > 0 && (
                                    <span className="text-[9px] text-muted-foreground">
                                      {signals.join(" · ")}
                                    </span>
                                  )}
                                </div>
                                {/* Why this carrier? — HF lane structured explanation */}
                                {c.carrierFitExplanation && (
                                  <div className="mt-1 flex flex-col gap-0.5" data-testid={`carrier-fit-explanation-${idx}`}>
                                    {c.carrierFitExplanation.exactLaneHistory.runCount > 0 && (
                                      <span className="flex items-center gap-1 text-[9px] text-emerald-400/80">
                                        <TrendingUp className="w-2.5 h-2.5 shrink-0" />
                                        {c.carrierFitExplanation.exactLaneHistory.runCount} exact run{c.carrierFitExplanation.exactLaneHistory.runCount !== 1 ? "s" : ""}
                                        {c.carrierFitExplanation.exactLaneHistory.lastRunDate && ` · last ${c.carrierFitExplanation.exactLaneHistory.lastRunDate}`}
                                      </span>
                                    )}
                                    {c.carrierFitExplanation.customerHistory.hasHistory && (
                                      <span className="flex items-center gap-1 text-[9px] text-blue-400/80">
                                        <ShieldCheck className="w-2.5 h-2.5 shrink-0" />
                                        Customer relationship · {c.carrierFitExplanation.customerHistory.runCount} load{c.carrierFitExplanation.customerHistory.runCount !== 1 ? "s" : ""}
                                      </span>
                                    )}
                                    {c.carrierFitExplanation.outreachHistory.lastStatus && (
                                      <span className="flex items-center gap-1 text-[9px] text-amber-400/60">
                                        <MailOpen className="w-2.5 h-2.5 shrink-0" />
                                        Last contact: {c.carrierFitExplanation.outreachHistory.lastStatus}
                                        {c.carrierFitExplanation.outreachHistory.lastDate && ` · ${new Date(c.carrierFitExplanation.outreachHistory.lastDate).toLocaleDateString()}`}
                                      </span>
                                    )}
                                    {c.carrierFitExplanation.fitSignals.hasMarketNbaBoost && (
                                      <span className="flex items-center gap-1 text-[9px] text-yellow-400/80">
                                        <Star className="w-2.5 h-2.5 shrink-0" />
                                        Market demand signal boost
                                      </span>
                                    )}
                                  </div>
                                )}
                                {/* Source / prospect badges */}
                                {(c.isNewProspect || (c.sourceChannel && SOURCE_LABELS[c.sourceChannel])) && (
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {c.isNewProspect && (
                                      <Badge variant="outline" className="text-[9px] py-0 px-1 border-border text-muted-foreground">New Prospect</Badge>
                                    )}
                                    {c.sourceChannel && SOURCE_LABELS[c.sourceChannel] && (
                                      <Badge variant="outline" className={`text-[9px] py-0 px-1 ${SOURCE_COLORS[c.sourceChannel] ?? "border-border text-muted-foreground"}`}>
                                        {SOURCE_LABELS[c.sourceChannel]}
                                      </Badge>
                                    )}
                                  </div>
                                )}
                                {/* Suppression reasons */}
                                {suppressions.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {suppressions.map((r, ri) => (
                                      <span key={ri} className="text-[9px] px-1 py-0 rounded border border-red-500/30 text-red-400 bg-red-500/5 flex items-center gap-0.5">
                                        <AlertCircle className="w-2 h-2 shrink-0" />{r}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                {/* View carrier profile link */}
                                {c.carrierId && (
                                  <a
                                    href={`/carrier-hub?carrierId=${c.carrierId}`}
                                    onClick={e => e.stopPropagation()}
                                    className="inline-flex items-center gap-0.5 text-[9px] text-amber-400/60 hover:text-amber-300 mt-1 transition-colors"
                                    data-testid={`link-carrier-profile-${idx}`}
                                  >
                                    <ExternalLink className="w-2.5 h-2.5" /> View profile
                                  </a>
                                )}
                              </div>
                              {/* Score bubble */}
                              <div className={`w-9 h-9 rounded-full flex items-center justify-center border-2 text-xs font-bold shrink-0 ${
                                c.fitScore >= 70 ? "border-emerald-500/60 text-emerald-300 bg-emerald-500/10" :
                                c.fitScore >= 45 ? "border-amber-500/60 text-amber-300 bg-amber-500/10" :
                                c.fitScore >= 1  ? "border-border text-muted-foreground bg-muted/20" :
                                                   "border-border/30 text-muted-foreground/40 bg-muted/10"
                              }`}>
                                {c.fitScore}
                              </div>
                            </div>
                          </button>
                          {/* Inline email affordances — shown when selected */}
                          {isSelected && (
                            <div className="ml-3 mr-0 -mt-1 bg-amber-500/5 border border-amber-500/15 border-t-0 rounded-b-lg px-3 pb-2 pt-2 flex flex-col gap-2">
                              <div>
                                <p className="text-[9px] mb-1 uppercase tracking-wide flex items-center gap-1 text-orange-400/70">
                                  <Mail className="w-2.5 h-2.5" />
                                  {c.primaryEmail ? "Carrier email (saved)" : "Add carrier email"}
                                </p>
                                <input
                                  type="email"
                                  value={capturedEmails[key] ?? c.primaryEmail ?? ""}
                                  onChange={e => setCapturedEmails(prev => ({ ...prev, [key]: e.target.value }))}
                                  placeholder={`email@${c.carrierName.toLowerCase().replace(/\s+/g, "")}.com`}
                                  className="w-full text-[11px] text-foreground/70 bg-muted/20 border border-border rounded px-2 py-1 placeholder:text-muted-foreground/30 focus:outline-none focus:border-orange-400/40"
                                  data-testid={`add-email-input-${idx}`}
                                />
                              </div>
                              <div>
                                <p className="text-[9px] text-amber-300/60 mb-1 uppercase tracking-wide">Custom note (optional)</p>
                                <Textarea
                                  value={inlineEmails[key] ?? ""}
                                  onChange={e => setInlineEmails(prev => ({ ...prev, [key]: e.target.value }))}
                                  placeholder={`Add a personalized note for ${c.carrierName}…`}
                                  className="text-[11px] text-foreground/70 bg-muted/20 border-border resize-none min-h-[50px] placeholder:text-muted-foreground/30"
                                  data-testid={`inline-email-${idx}`}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-2 mt-4" data-testid="pagination-controls">
                      <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage <= 1} className="text-[10px] px-2 py-1 rounded border border-border text-muted-foreground bg-muted/20 hover:bg-muted/40 disabled:opacity-40 transition-colors" data-testid="btn-prev-page">← Prev</button>
                      <span className="text-[10px] text-muted-foreground">Page {currentPage} of {totalPages}</span>
                      <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages} className="text-[10px] px-2 py-1 rounded border border-border text-muted-foreground bg-muted/20 hover:bg-muted/40 disabled:opacity-40 transition-colors" data-testid="btn-next-page">Next →</button>
                    </div>
                  )}
                </div>
              )}

              {/* ── BENCH SUB-TAB ──────────────────────────────────────── */}
              {activeCarriersSubTab === "bench" && (
                <div className="flex-1 px-5 pt-3 pb-24 overflow-y-auto">
                  {/* Contactability warning */}
                  {bench.length > 0 && bench.every(b => !b.isContactable) && (
                    <div className="mb-3 flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-md px-3 py-2" data-testid="no-contactable-carriers-warning">
                      <AlertCircle className="w-3.5 h-3.5 text-orange-400 shrink-0" />
                      <p className="text-[11px] text-orange-300">No carriers on this bench have a phone or email on file. Add contact details in the Carriers catalog.</p>
                    </div>
                  )}
                  {bench.length === 0 ? (
                    <div className="text-center py-8">
                      <div className="w-10 h-10 rounded-full bg-muted/20 border border-border flex items-center justify-center mx-auto mb-3">
                        <Truck className="w-5 h-5 text-muted-foreground" />
                      </div>
                      <p className="text-xs text-muted-foreground">No carriers on the bench yet.</p>
                      <p className="text-[10px] text-muted-foreground/60 mt-1">Select carriers from Ranked and mark them as contacted.</p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {/* Historical carrier callout */}
                      {(() => {
                        const historicalMissingContact = bench.filter(b => b.sourceType === "historical" && !b.isContactable);
                        if (historicalMissingContact.length === 0) return null;
                        return (
                          <div className="bg-blue-500/8 border border-blue-500/20 rounded-lg p-3 flex items-start gap-2 mb-1" data-testid="historical-carriers-callout">
                            <Truck className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
                            <div>
                              <p className="text-[11px] font-semibold text-blue-300">{historicalMissingContact.length} historical carrier{historicalMissingContact.length > 1 ? "s" : ""} missing contact info</p>
                              <p className="text-[10px] text-blue-300/60 mt-0.5">Add phone or email in the Carrier catalog to enable outreach.</p>
                              <p className="text-[10px] text-muted-foreground mt-1">{historicalMissingContact.map(b => b.carrierName).join(", ")}</p>
                            </div>
                          </div>
                        );
                      })()}
                      {bench.map(interest => {
                        const statusConfig = INTEREST_STATUS_LABELS[interest.interestStatus] ?? INTEREST_STATUS_LABELS.needs_follow_up;
                        const isExpanded = expandedReply === interest.id;
                        return (
                          <div key={interest.id} className="bg-muted/10 rounded-lg border border-border p-3" data-testid={`bench-item-${interest.id}`}>
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <p className="text-xs font-semibold text-foreground truncate">{interest.carrierName}</p>
                                  {interest.sourceType === "historical" && (
                                    <Badge variant="outline" className="text-[9px] py-0 px-1 border-blue-500/30 text-blue-400">Ran this lane</Badge>
                                  )}
                                  {!interest.isContactable && (
                                    <Badge variant="outline" className="text-[9px] py-0 px-1 border-orange-500/30 text-orange-400 flex items-center gap-0.5">
                                      <Mail className="w-2.5 h-2.5" /> No contact info
                                    </Badge>
                                  )}
                                </div>
                                {interest.outreachSentAt && (
                                  <p className="text-[10px] text-muted-foreground mt-0.5">Contacted {new Date(interest.outreachSentAt).toLocaleDateString()}</p>
                                )}
                                {interest.lastReplySnippet && (
                                  <p className="text-[10px] text-muted-foreground italic mt-0.5 line-clamp-2">"{interest.lastReplySnippet}"</p>
                                )}
                              </div>
                              <Badge variant="outline" className={`text-[9px] py-0 px-1.5 shrink-0 ${statusConfig.color}`}>{statusConfig.label}</Badge>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1">
                              {([
                                { value: "available_now", label: "Avail. Now" },
                                { value: "available_next_week", label: "Next Wk" },
                                { value: "future_interest", label: "Future" },
                                { value: "not_fit", label: "Not a Fit" },
                              ] as const).map(opt => (
                                <button
                                  key={opt.value}
                                  onClick={() => setInterestStatusMutation.mutate({ carrierId: interest.carrierId ?? null, carrierName: interest.carrierName, interestStatus: opt.value })}
                                  disabled={setInterestStatusMutation.isPending}
                                  className={`text-[9px] px-1.5 py-0.5 rounded border transition-colors ${
                                    interest.interestStatus === opt.value
                                      ? "border-blue-400/60 bg-blue-500/20 text-blue-300"
                                      : "border-border bg-muted/20 text-muted-foreground hover:text-foreground/60"
                                  }`}
                                  data-testid={`status-${opt.value}-${interest.id}`}
                                >
                                  {interest.interestStatus === opt.value ? "✓ " : ""}{opt.label}
                                </button>
                              ))}
                            </div>
                            <button
                              onClick={() => setExpandedReply(isExpanded ? null : interest.id)}
                              className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground/60"
                              data-testid={`classify-toggle-${interest.id}`}
                            >
                              <Mail className="w-3 h-3" /> Classify reply
                              {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                            </button>
                            {isExpanded && (
                              <div className="mt-2 flex flex-col gap-2">
                                <Textarea
                                  placeholder="Paste carrier reply here…"
                                  value={replyInputs[interest.id] ?? ""}
                                  onChange={e => setReplyInputs(prev => ({ ...prev, [interest.id]: e.target.value }))}
                                  className="text-[11px] text-foreground/70 bg-muted/20 border-border resize-none min-h-[60px]"
                                  data-testid={`reply-input-${interest.id}`}
                                />
                                <Button size="sm" onClick={() => handleClassifyReply(interest)}
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
                </div>
              )}

              {/* ── IMPORT SUB-TAB ─────────────────────────────────────── */}
              {activeCarriersSubTab === "import" && (
                <div className="flex-1 px-5 pt-3 pb-24 overflow-y-auto" data-testid="tab-content-import">
                  {/* Paste Emails (Ad-hoc outreach) */}
                  <div className="mb-5">
                    <button
                      onClick={() => setAdHocEmailsExpanded(v => !v)}
                      className="w-full flex items-center justify-between gap-2 py-2 text-left"
                      data-testid="btn-toggle-paste-emails"
                    >
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 rounded bg-blue-500/20 flex items-center justify-center shrink-0">
                          <Mail className="w-3 h-3 text-blue-400" />
                        </div>
                        <span className="text-xs font-semibold text-foreground/80">Paste Email Addresses</span>
                        {adHocParsed.valid.length > 0 && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/20 border border-blue-500/30 text-blue-300">{adHocParsed.valid.length} ready</span>
                        )}
                      </div>
                      {adHocEmailsExpanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
                    </button>
                    {adHocEmailsExpanded && (
                      <div className="flex flex-col gap-3 mt-2 p-3 bg-muted/15 border border-border rounded-lg">
                        <p className="text-[10px] text-muted-foreground">Paste email addresses for carriers not in the catalog — from DAT, broker groups, etc. No carrier records are created.</p>
                        <Textarea
                          value={adHocEmailPasteText}
                          onChange={e => setAdHocEmailPasteText(e.target.value)}
                          placeholder={"carrier@example.com, dispatcher@trucking.com\nops@freightco.com"}
                          className="text-[11px] text-foreground/70 bg-muted/20 border-border resize-none min-h-[80px] placeholder:text-muted-foreground/30 font-mono"
                          data-testid="textarea-adhoc-emails"
                        />
                        {adHocEmailPasteText.trim() && (
                          <div className="flex flex-col gap-1.5">
                            {adHocParsed.valid.length > 0 && (
                              <div className="flex items-center gap-1.5">
                                <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                                <span className="text-[10px] text-emerald-300 font-medium">{adHocParsed.valid.length} valid address{adHocParsed.valid.length !== 1 ? "es" : ""} found</span>
                              </div>
                            )}
                            {adHocParsed.invalid.length > 0 && (
                              <div className="flex items-start gap-1.5">
                                <AlertCircle className="w-3 h-3 text-orange-400 shrink-0 mt-0.5" />
                                <div>
                                  <span className="text-[10px] text-orange-300">{adHocParsed.invalid.length} invalid (will be skipped):</span>
                                  <span className="text-[10px] text-orange-400/70 ml-1 break-all">{adHocParsed.invalid.join(", ")}</span>
                                </div>
                              </div>
                            )}
                            {adHocParsed.valid.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1">
                                {adHocParsed.valid.map((email, i) => (
                                  <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-blue-300 font-mono">{email}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {adHocEmailPasteText.trim() && (
                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => setAdHocEmailPasteText("")} variant="outline" className="h-7 text-[10px] border-border text-muted-foreground hover:bg-muted/20" data-testid="btn-clear-adhoc-emails">Clear</Button>
                            {adHocParsed.valid.length > 0 && (
                              <p className="text-[10px] text-blue-400/70 flex items-center gap-1 flex-1">
                                <Mail className="w-2.5 h-2.5" /> These will be included in outreach from the Message tab
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="border-t border-border mb-4" />
                  {importResults ? (
                    <div className="flex flex-col gap-4">
                      <div className="flex items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                        <div>
                          <p className="text-xs font-semibold text-emerald-300">{importResults.filter(r => r.status === "new").length} new carriers imported</p>
                          {importResults.filter(r => r.status === "matched").length > 0 && (
                            <p className="text-[10px] text-muted-foreground">{importResults.filter(r => r.status === "matched").length} matched existing catalog records</p>
                          )}
                          <p className="text-[10px] text-muted-foreground">All carriers added to lane bench</p>
                        </div>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {importResults.map((r, idx) => (
                          <div key={idx} className="flex items-center gap-2 p-2 bg-muted/15 rounded border border-border">
                            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${r.status === "new" ? "bg-emerald-400" : "bg-amber-400"}`} />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-foreground truncate">{r.carrier.name}</p>
                              {r.carrier.primaryEmail && <p className="text-[10px] text-muted-foreground truncate">{r.carrier.primaryEmail}</p>}
                            </div>
                            <Badge variant="outline" className={`text-[9px] py-0 px-1 shrink-0 ${r.status === "new" ? "border-emerald-500/40 text-emerald-400" : "border-amber-500/40 text-amber-400"}`}>
                              {r.status === "new" ? "New" : r.matchType === "email_exact" ? "Email match" : r.matchType === "mc_exact" ? "MC match" : "Name match"}
                            </Badge>
                            <a href={`/carrier-hub?carrierId=${r.carrier.id}`} target="_blank" rel="noopener noreferrer" className="p-0.5 text-muted-foreground hover:text-foreground/80 transition-colors shrink-0" data-testid={`link-hub-import-result-${r.carrier.id}`}>
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                        ))}
                      </div>
                      <Button variant="outline" size="sm" onClick={() => { setImportResults(null); setParsedImportCarriers(null); setImportPasteText(""); }} className="w-full text-xs border-border text-muted-foreground hover:bg-muted/30" data-testid="btn-import-again">
                        <Upload className="w-3 h-3 mr-1" /> Import More Carriers
                      </Button>
                    </div>
                  ) : parsedImportCarriers ? (
                    <div className="flex flex-col gap-4">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold text-foreground">{parsedImportCarriers.length} carriers parsed</p>
                        <button onClick={() => setParsedImportCarriers(null)} className="text-[10px] text-muted-foreground hover:text-foreground/60" data-testid="btn-import-back">← Edit</button>
                      </div>
                      <div className="flex flex-col gap-1">
                        <div className="grid grid-cols-12 gap-2 px-2 py-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                          <span className="col-span-5">Name</span>
                          <span className="col-span-4">Email</span>
                          <span className="col-span-3">MC#</span>
                        </div>
                        {parsedImportCarriers.map((c, idx) => (
                          <div key={idx} className="grid grid-cols-12 gap-2 px-2 py-1.5 bg-muted/15 rounded border border-border">
                            <span className="col-span-5 text-[10px] text-foreground truncate">{c.name}</span>
                            <span className="col-span-4 text-[10px] text-muted-foreground truncate">{c.email ?? "—"}</span>
                            <span className="col-span-3 text-[10px] text-muted-foreground truncate">{c.mcDot ?? "—"}</span>
                          </div>
                        ))}
                      </div>
                      <Button size="sm"
                        onClick={() => importCarriersMutation.mutate({ carriers: parsedImportCarriers, source: importSource, rawInput: importPasteText })}
                        disabled={importCarriersMutation.isPending}
                        className="w-full text-xs bg-amber-500 hover:bg-amber-400 text-black font-semibold"
                        data-testid="btn-confirm-import"
                      >
                        {importCarriersMutation.isPending
                          ? <><Loader2 className="w-3 h-3 animate-spin mr-1" />Importing…</>
                          : <><Plus className="w-3 h-3 mr-1" />Import & Add {parsedImportCarriers.length} to Bench</>
                        }
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-4">
                      <p className="text-xs text-muted-foreground">Paste carrier contacts from DAT, Loadsmart, or any other platform. Supports tab-delimited, CSV, or plain name + email format.</p>
                      <div className="text-[9px] text-muted-foreground font-mono bg-muted/15 border border-border rounded px-2 py-1.5 space-y-0.5">
                        <div className="text-muted-foreground mb-1">Supported formats (one per line):</div>
                        <div>ABC Transport Inc, abc@transport.com, MC123456</div>
                        <div>XYZ Logistics | xyz@logistics.com</div>
                        <div>Smith Trucking LLC {"  "} MC789012</div>
                      </div>
                      <div>
                        <p className="text-[9px] text-muted-foreground uppercase tracking-wide mb-1.5">Source Platform</p>
                        <Select value={importSource} onValueChange={setImportSource}>
                          <SelectTrigger className="h-8 text-xs bg-muted/20 border-border text-foreground/80" data-testid="select-import-source">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="dat">DAT Load Board</SelectItem>
                            <SelectItem value="loadsmart">Loadsmart</SelectItem>
                            <SelectItem value="csv_paste">CSV / Spreadsheet Paste</SelectItem>
                            <SelectItem value="manual">Manual Entry</SelectItem>
                            <SelectItem value="other">Other Platform</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <p className="text-[9px] text-muted-foreground uppercase tracking-wide mb-1.5">Carrier List</p>
                        <Textarea
                          value={importPasteText}
                          onChange={e => setImportPasteText(e.target.value)}
                          placeholder={"ABC Transport Inc, abc@transport.com, MC123456\nXYZ Logistics, xyz@example.com\nSmith Trucking LLC"}
                          className="text-[11px] text-foreground/70 bg-muted/20 border-border resize-none min-h-[160px] placeholder:text-muted-foreground/30 font-mono"
                          data-testid="textarea-import-paste"
                        />
                        {importPasteText && (
                          <p className="text-[9px] text-muted-foreground mt-1">{importPasteText.split("\n").filter(l => l.trim().length > 2).length} lines detected</p>
                        )}
                      </div>
                      <Button size="sm"
                        onClick={() => {
                          const parsed = parseImportText(importPasteText);
                          if (parsed.length === 0) {
                            toast({ title: "No carriers parsed", description: "Check format and try again.", variant: "destructive" });
                            return;
                          }
                          setParsedImportCarriers(parsed);
                        }}
                        disabled={!importPasteText.trim()}
                        className="w-full text-xs bg-amber-500 hover:bg-amber-400 text-black font-semibold"
                        data-testid="btn-parse-import"
                      >
                        <ExternalLink className="w-3 h-3 mr-1" /> Parse & Preview
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════ */}
          {/* MESSAGE TAB                                                   */}
          {/* ══════════════════════════════════════════════════════════════ */}
          {activeMainTab === "message" && (
            <div className="flex-1 px-5 pt-4 pb-24 overflow-y-auto">
              {/* Selected recipients summary */}
              {selectedCarriers.size > 0 ? (
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
                      Recipients ({selectedCarriers.size}{adHocParsed.valid.length > 0 ? ` + ${adHocParsed.valid.length} ad-hoc` : ""})
                    </p>
                    <button onClick={() => setActiveMainTab("carriers")} className="text-[10px] text-amber-400/70 hover:text-amber-300 transition-colors">
                      ← Edit selection
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {filteredCarriers.filter(c => selectedCarriers.has(c.carrierId ?? c.carrierName)).map((c, i) => (
                      <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-muted/20 border border-border text-foreground/70 flex items-center gap-1">
                        {c.carrierName}
                        <button onClick={() => toggleCarrier(c)} className="text-muted-foreground hover:text-red-400 transition-colors leading-none" data-testid={`remove-recipient-${i}`}>×</button>
                      </span>
                    ))}
                    {adHocParsed.valid.length > 0 && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300">
                        +{adHocParsed.valid.length} ad-hoc email{adHocParsed.valid.length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>
              ) : adHocParsed.valid.length === 0 ? (
                <div className="text-center py-8">
                  <div className="w-10 h-10 rounded-full bg-muted/20 border border-border flex items-center justify-center mx-auto mb-3">
                    <Mail className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <p className="text-xs text-muted-foreground">No carriers selected yet.</p>
                  <button onClick={() => setActiveMainTab("carriers")} className="mt-2 text-[11px] text-amber-400/70 hover:text-amber-300 transition-colors">
                    ← Go to Carriers to select
                  </button>
                </div>
              ) : null}

              {/* Template selector + editor — shown when no drafts yet */}
              {(selectedCarriers.size > 0 || adHocParsed.valid.length > 0) && !showEmails && (
                <>
                  {/* ── Template selector ── */}
                  <div className="mb-3">
                    <div className="flex items-center gap-2 mb-1.5">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium shrink-0">Template</p>
                      <Select value={selectedTemplateId} onValueChange={handleTemplateSelect}>
                        <SelectTrigger className="flex-1 h-7 text-xs bg-muted/20 border-border text-foreground/80" data-testid="template-selector">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border text-foreground">
                          {OUTREACH_TEMPLATES.map(t => (
                            <SelectItem key={t.id} value={t.id} className="text-xs">{t.label}</SelectItem>
                          ))}
                          <SelectItem value="__ai__" className="text-xs text-blue-400">AI Draft (let AI write it)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Unsaved-edit confirmation */}
                    {pendingTemplateId && (
                      <div className="mb-2 flex items-center gap-2 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2" data-testid="template-switch-confirm">
                        <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        <p className="text-[11px] text-amber-300 flex-1">Switching templates will replace your current edits. Continue?</p>
                        <button
                          onClick={() => {
                            if (pendingTemplateId === "__ai__") {
                              setSharedTemplate(""); setSharedSubject(""); setLastAppliedBody(""); setLastAppliedSubject(""); setSelectedTemplateId("__ai__");
                            } else {
                              applyTemplateToEditor(pendingTemplateId);
                            }
                            setPendingTemplateId(null);
                          }}
                          className="text-[10px] px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/40 text-amber-300 hover:bg-amber-500/30 transition-colors"
                          data-testid="btn-confirm-template-switch"
                        >
                          Replace
                        </button>
                        <button
                          onClick={() => setPendingTemplateId(null)}
                          className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-muted/20 transition-colors"
                          data-testid="btn-cancel-template-switch"
                        >
                          Keep edits
                        </button>
                      </div>
                    )}

                    {/* Subject field */}
                    <div className="mb-2">
                      <p className="text-[9px] text-muted-foreground uppercase tracking-wide mb-1">Subject</p>
                      <input
                        type="text"
                        value={sharedSubject}
                        onChange={e => setSharedSubject(e.target.value)}
                        className="w-full text-[11px] text-foreground/80 bg-muted/20 border border-border rounded px-2.5 py-1.5 focus:outline-none focus:border-amber-400/40 placeholder:text-muted-foreground/30"
                        placeholder="Email subject line…"
                        data-testid="template-subject-input"
                      />
                    </div>

                    {/* Body editor */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-[9px] text-muted-foreground uppercase tracking-wide">
                          Message body
                          {sharedTemplate.includes("{{carrierName}}") && (
                            <span className="ml-1.5 text-amber-400/60 normal-case font-normal">· {"{{carrierName}}"} will be filled per carrier</span>
                          )}
                        </p>
                        <div className="flex items-center gap-2">
                          {isTemplateDirty() && (
                            <span className="text-[9px] text-amber-400/70 italic">edited</span>
                          )}
                          {sharedTemplate.trim() && (
                            <button
                              onClick={() => { setSharedTemplate(""); setSharedSubject(""); setLastAppliedBody(""); setLastAppliedSubject(""); }}
                              className="text-[9px] text-muted-foreground hover:text-foreground/50"
                              data-testid="clear-shared-template"
                            >
                              Clear (use AI)
                            </button>
                          )}
                        </div>
                      </div>
                      <Textarea
                        value={sharedTemplate}
                        onChange={e => setSharedTemplate(e.target.value)}
                        placeholder="Leave blank to let AI draft personalised emails per carrier…"
                        className="text-[11px] text-foreground/70 bg-muted/20 border-border resize-none min-h-[120px] placeholder:text-muted-foreground/30"
                        data-testid="shared-template-editor"
                      />
                      {sharedTemplate.trim() && (
                        <p className="text-[9px] text-emerald-400/70 mt-1 flex items-center gap-1">
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          Template will be sent to {selectedCarriers.size + adHocParsed.valid.length} recipient(s) — skip AI
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Outreach mode */}
                  <div className="flex items-center gap-2 mb-4">
                    <span className="text-[10px] text-muted-foreground shrink-0">Outreach mode:</span>
                    <Select value={outreachMode} onValueChange={(v: "lane_building" | "immediate_plus_lane") => setOutreachMode(v)}>
                      <SelectTrigger className="h-7 text-xs bg-muted/20 border-border text-foreground/80 flex-1" data-testid="outreach-mode-select-message">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-card border-border text-foreground">
                        <SelectItem value="lane_building" className="text-xs">Lane-Building (recurring framing)</SelectItem>
                        <SelectItem value="immediate_plus_lane" className="text-xs">Immediate Load + Lane Building</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}

              {/* Email drafts — main editing area */}
              {showEmails && emailDrafts.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-semibold text-foreground/80">Drafted Emails ({emailDrafts.length})</p>
                      {sendOverallStatus === "done" && (
                        <span className="text-[9px] text-emerald-400 flex items-center gap-0.5"><CheckCircle2 className="w-2.5 h-2.5" /> Sent</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => navigator.clipboard.writeText(emailDrafts.map(d => `To: ${d.carrierName}\nSubject: ${d.subject}\n\n${d.body}`).join("\n\n---\n\n"))}
                        className="text-[10px] text-muted-foreground hover:text-foreground/60 flex items-center gap-0.5"
                        data-testid="btn-copy-all-drafts"
                        title="Copy all drafts to clipboard"
                      >
                        <Copy className="w-2.5 h-2.5" /> Copy all
                      </button>
                      <button
                        onClick={() => { setShowEmails(false); setEmailDrafts([]); setSendOverallStatus("idle"); setDraftSendStatus({}); setDraftsFromTemplate(false); }}
                        className="text-[10px] text-muted-foreground hover:text-foreground/60"
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-4">
                    {emailDrafts.map((draft, i) => {
                      const status = draftSendStatus[i];
                      return (
                        <div key={i} className={`rounded-lg border p-3 ${
                          status === "sent" ? "bg-emerald-500/5 border-emerald-500/20" :
                          status === "failed" ? "bg-red-500/5 border-red-500/20" :
                          status === "no_email" ? "bg-orange-500/5 border-orange-500/20" :
                          status === "dedup_skipped" ? "bg-yellow-500/5 border-yellow-500/20" :
                          status === "throttled_daily_cap" ? "bg-rose-500/5 border-rose-500/20" :
                          status === "throttled_too_soon" ? "bg-amber-500/5 border-amber-500/20" :
                          "bg-muted/10 border-border"
                        }`}>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-[10px] font-semibold text-amber-300">{draft.carrierName}</p>
                            <div className="flex items-center gap-1.5">
                              {sendOverallStatus === "idle" && draftsFromTemplate && emailDrafts.length > 1 && !draft.carrierName.startsWith("Ad-hoc:") && (
                                <button
                                  onClick={() => openBulkEditModal(i)}
                                  className="text-[9px] text-muted-foreground hover:text-foreground/60 flex items-center gap-0.5"
                                  title="Edit this draft and apply changes to all"
                                  data-testid={`btn-edit-apply-all-${i}`}
                                >
                                  <PenLine className="w-2.5 h-2.5" /> Edit & Apply to All
                                </button>
                              )}
                              <button onClick={() => navigator.clipboard.writeText(draft.body)} className="text-[9px] text-muted-foreground hover:text-foreground/60" title="Copy body" data-testid={`btn-copy-draft-${i}`}>
                                <Copy className="w-2.5 h-2.5" />
                              </button>
                              {status === "sent" && <span className="text-[9px] text-emerald-400 flex items-center gap-0.5" data-testid={`draft-status-sent-${i}`}><CheckCircle2 className="w-2.5 h-2.5" /> Sent</span>}
                              {status === "failed" && <span className="text-[9px] text-red-400 flex items-center gap-0.5" data-testid={`draft-status-failed-${i}`}><XCircle className="w-2.5 h-2.5" /> Failed</span>}
                              {status === "no_email" && <span className="text-[9px] text-orange-400 flex items-center gap-0.5" data-testid={`draft-status-no-email-${i}`}><AlertCircle className="w-2.5 h-2.5" /> No email</span>}
                              {status === "dedup_skipped" && <span className="text-[9px] text-yellow-400 flex items-center gap-0.5" data-testid={`draft-status-dedup-skipped-${i}`}><AlertCircle className="w-2.5 h-2.5" /> Already contacted (48h)</span>}
                              {status === "throttled_daily_cap" && <span className="text-[9px] text-rose-400 flex items-center gap-0.5" data-testid={`draft-status-throttled-daily-cap-${i}`}><AlertCircle className="w-2.5 h-2.5" /> Daily limit reached</span>}
                              {status === "throttled_too_soon" && <span className="text-[9px] text-amber-400 flex items-center gap-0.5" data-testid={`draft-status-throttled-too-soon-${i}`}><AlertCircle className="w-2.5 h-2.5" /> Sent too recently</span>}
                              {status === "sending" && <span className="text-[9px] text-blue-400 flex items-center gap-0.5" data-testid={`draft-status-sending-${i}`}><Loader2 className="w-2.5 h-2.5 animate-spin" /> Sending</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 mb-2">
                            <span className="text-[10px] text-muted-foreground shrink-0">Subject:</span>
                            <input
                              type="text"
                              value={draft.subject}
                              onChange={e => setEmailDrafts(prev => { const next = [...prev]; next[i] = { ...next[i], subject: e.target.value }; return next; })}
                              disabled={sendOverallStatus !== "idle"}
                              className="flex-1 text-[11px] text-foreground/70 bg-muted/20 border border-border rounded px-2 py-0.5 focus:outline-none focus:border-amber-400/40 disabled:opacity-60 placeholder:text-muted-foreground/30"
                              data-testid={`email-subject-${i}`}
                            />
                          </div>
                          <Textarea
                            value={draft.body}
                            onChange={e => setEmailDrafts(prev => { const next = [...prev]; next[i] = { ...next[i], body: e.target.value }; return next; })}
                            disabled={sendOverallStatus !== "idle"}
                            className="text-[11px] text-foreground/70 bg-muted/20 border-border resize-none min-h-[140px] disabled:opacity-60"
                            data-testid={`email-draft-${i}`}
                          />
                          {(status === "throttled_daily_cap" || status === "throttled_too_soon") && (() => {
                            const result = sendOutreachMutation.data?.results?.[i] as { throttleMessage?: string } | undefined;
                            const msg = result?.throttleMessage;
                            if (!msg) return null;
                            return (
                              <p className="mt-1.5 text-[9px] text-muted-foreground flex items-start gap-1" data-testid={`throttle-reason-${i}`}>
                                <AlertCircle className="w-2.5 h-2.5 mt-0.5 shrink-0 text-rose-400" />
                                {msg}
                              </p>
                            );
                          })()}
                        </div>
                      );
                    })}
                  </div>
                  {sendOverallStatus === "done" && (() => {
                    const sentCt = Object.values(draftSendStatus).filter(s => s === "sent").length;
                    const noEmailCt = Object.values(draftSendStatus).filter(s => s === "no_email").length;
                    const dedupCt = Object.values(draftSendStatus).filter(s => s === "dedup_skipped").length;
                    const dailyCapCt = Object.values(draftSendStatus).filter(s => s === "throttled_daily_cap").length;
                    const tooSoonCt = Object.values(draftSendStatus).filter(s => s === "throttled_too_soon").length;
                    if (sentCt > 0) {
                      const blockedParts: string[] = [];
                      if (dailyCapCt > 0) blockedParts.push(`${dailyCapCt} daily limit reached`);
                      if (tooSoonCt > 0) blockedParts.push(`${tooSoonCt} sent too recently`);
                      if (dedupCt > 0) blockedParts.push(`${dedupCt} already contacted (48h)`);
                      if (noEmailCt > 0) blockedParts.push(`${noEmailCt} missing email`);
                      return (
                        <div className="mt-3 flex flex-col gap-1">
                          <p className="text-[10px] text-emerald-400/70 flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" />
                            {sentCt} email{sentCt > 1 ? "s" : ""} sent and logged. Check the History tab for details.
                          </p>
                          {blockedParts.length > 0 && (
                            <p className="text-[10px] text-amber-400/70 flex items-center gap-1" data-testid="throttle-summary-message">
                              <AlertCircle className="w-3 h-3" />
                              {blockedParts.join(", ")}.
                            </p>
                          )}
                        </div>
                      );
                    }
                    const parts: string[] = [];
                    if (noEmailCt > 0) parts.push(`${noEmailCt} carrier${noEmailCt > 1 ? "s" : ""} missing email`);
                    if (dedupCt > 0) parts.push(`${dedupCt} already contacted within 48h`);
                    if (dailyCapCt > 0) parts.push(`${dailyCapCt} daily limit reached`);
                    if (tooSoonCt > 0) parts.push(`${tooSoonCt} sent too recently`);
                    return (
                      <p className="mt-3 text-[10px] text-orange-400/80 flex items-center gap-1" data-testid="throttle-summary-message">
                        <AlertCircle className="w-3 h-3" />
                        No emails sent — {parts.length ? parts.join(", ") + "." : "all carriers skipped."}
                      </p>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════ */}
          {/* FOLLOW-UP TAB                                                 */}
          {/* ══════════════════════════════════════════════════════════════ */}
          {activeMainTab === "followup" && (
            <div className="flex-1 px-5 pt-4 pb-20 overflow-y-auto">
              {followupLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground text-xs py-4">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading suggestions…
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {(followupData?.suggestions ?? []).length === 0 && (
                    <div className="text-center py-8">
                      <div className="w-10 h-10 rounded-full bg-muted/20 border border-border flex items-center justify-center mx-auto mb-3">
                        <Lightbulb className="w-5 h-5 text-muted-foreground" />
                      </div>
                      <p className="text-xs text-muted-foreground">No follow-up suggestions yet.</p>
                      <p className="text-[10px] text-muted-foreground/60 mt-1">Contact some carriers first to get follow-up guidance.</p>
                    </div>
                  )}
                  {(followupData?.suggestions ?? []).map((s, i) => (
                    <div
                      key={i}
                      className={`p-3 rounded-lg border flex items-start gap-2 ${
                        s.priority === "high" ? "bg-amber-500/8 border-amber-500/20" :
                        s.priority === "medium" ? "bg-muted/10 border-border" :
                        "bg-muted/10 border-border/60"
                      }`}
                      data-testid={`followup-suggestion-${i}`}
                    >
                      <Lightbulb className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
                        s.priority === "high" ? "text-amber-400" :
                        s.priority === "medium" ? "text-muted-foreground" : "text-foreground/30"
                      }`} />
                      <p className="text-xs text-foreground/70">{s.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════ */}
          {/* HISTORY TAB                                                   */}
          {/* ══════════════════════════════════════════════════════════════ */}
          {activeMainTab === "history" && (
            <div className="flex-1 px-5 pt-4 pb-20 overflow-y-auto">
              {/* Admin-only: non-blocking notice when inbound reply tracking is not active */}
              {isAdmin && replyTrackingStatus && !replyTrackingStatus.enabled && (
                <div
                  className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[10px] text-amber-400/80"
                  data-testid="reply-tracking-warning"
                >
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-semibold mb-0.5">Inbound reply tracking inactive</p>
                    {(replyTrackingStatus.missingPermissions?.length ?? 0) > 0 && (
                      <p className="text-amber-400/60">
                        Missing: {replyTrackingStatus.missingPermissions.join(" · ")}
                      </p>
                    )}
                    {(replyTrackingStatus.warnings ?? []).map((w, i) => (
                      <p key={i} className="text-amber-400/60">{w}</p>
                    ))}
                  </div>
                </div>
              )}
              {isHistoryLoading ? (
                <div className="flex flex-col gap-3 animate-pulse" data-testid="history-loading">
                  {[1, 2, 3].map(i => <div key={i} className="h-16 rounded-lg bg-muted/30 border border-border" />)}
                </div>
              ) : isHistoryError ? (
                <div className="flex flex-col items-center gap-2 py-6 text-center" data-testid="history-error">
                  <XCircle className="w-5 h-5 text-red-400" />
                  <p className="text-xs text-red-400 font-medium">Could not load outreach history</p>
                  <p className="text-[10px] text-muted-foreground">Contact support if this persists</p>
                  <button onClick={() => refetchHistory()} className="mt-1 text-[10px] text-muted-foreground underline hover:text-foreground/70" data-testid="history-retry">Try again</button>
                </div>
              ) : outreachHistory.length === 0 ? (
                <div className="text-center py-8" data-testid="history-empty">
                  <div className="w-10 h-10 rounded-full bg-muted/20 border border-border flex items-center justify-center mx-auto mb-3">
                    <History className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <p className="text-xs text-muted-foreground">No outreach history yet for this lane.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {outreachHistory.map(log => {
                    const logAny = log as unknown as Record<string, unknown>;
                    const isInbound = logAny.direction === "inbound";
                    const status = log.deliveryStatus ?? "draft";
                    const statusConfig = isInbound
                      ? { label: "Reply", color: "text-blue-400", icon: <Mail className="w-3 h-3" /> }
                      : ({
                          sent:     { label: "Sent",     color: "text-emerald-400", icon: <CheckCircle2 className="w-3 h-3" /> },
                          partial:  { label: "Partial",  color: "text-amber-400",  icon: <AlertCircle className="w-3 h-3" /> },
                          failed:   { label: "Failed",   color: "text-red-400",    icon: <XCircle className="w-3 h-3" /> },
                          received: { label: "Received", color: "text-blue-400",   icon: <Mail className="w-3 h-3" /> },
                          draft:    { label: "Logged",   color: "text-muted-foreground", icon: <ClipboardCheck className="w-3 h-3" /> },
                        }[status] ?? { label: status, color: "text-muted-foreground", icon: <Clock className="w-3 h-3" /> });

                    const matchConfidence = logAny.matchConfidence as string | null | undefined;
                    const bodyPreview = logAny.bodyPreview as string | null | undefined;
                    const receivedAt = logAny.receivedAt as string | null | undefined;
                    const matchConfidenceConfig: Record<string, { label: string; color: string }> = {
                      exact:             { label: "Exact match",     color: "text-emerald-400" },
                      alternate_contact: { label: "Alt contact",     color: "text-blue-400" },
                      ambiguous:         { label: "Ambiguous",       color: "text-amber-400" },
                      unmatched:         { label: "Unmatched",       color: "text-muted-foreground" },
                    };
                    const matchCfg = matchConfidence ? matchConfidenceConfig[matchConfidence] : null;

                    return (
                      <div
                        key={log.id}
                        className={`rounded-lg border p-3 ${isInbound ? "bg-blue-500/5 border-blue-500/20" : "bg-muted/10 border-border"}`}
                        data-testid={`outreach-log-${log.id}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className={`flex items-center gap-1 text-[10px] font-semibold ${statusConfig.color}`}>
                                {statusConfig.icon} {statusConfig.label}
                              </span>
                              {isInbound && (
                                <span className="px-1 py-0.5 rounded text-[8px] font-medium bg-blue-500/15 border border-blue-500/20 text-blue-400" data-testid={`log-direction-inbound-${log.id}`}>
                                  Inbound
                                </span>
                              )}
                              {!isInbound && (
                                <>
                                  <span className="text-[9px] text-muted-foreground">·</span>
                                  <span className="text-[9px] text-muted-foreground">{log.outreachMode === "immediate_plus_lane" ? "Immediate + Lane" : "Lane-Building"}</span>
                                  {log.replyReceivedAt && (
                                    <span className="flex items-center gap-0.5 text-[10px] font-semibold text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded px-1 py-0.5" data-testid={`reply-received-badge-${log.id}`}>
                                      <MailOpen className="w-2.5 h-2.5" /> Reply Received
                                    </span>
                                  )}
                                </>
                              )}
                              {matchCfg && (
                                <span className={`text-[8px] ${matchCfg.color}`} data-testid={`log-match-confidence-${log.id}`}>
                                  · {matchCfg.label}
                                </span>
                              )}
                            </div>
                            {isInbound ? (
                              <>
                                {logAny.fromEmail && (
                                  <p className="text-[10px] text-foreground/70 mt-1 font-medium" data-testid={`log-from-email-${log.id}`}>
                                    From: {logAny.fromEmail as string}
                                  </p>
                                )}
                                {bodyPreview && (
                                  <p className="text-[9px] text-muted-foreground mt-0.5 italic truncate" data-testid={`log-body-preview-${log.id}`}>
                                    "{bodyPreview}"
                                  </p>
                                )}
                                {receivedAt && (
                                  <p className="text-[9px] text-muted-foreground mt-0.5" data-testid={`log-received-at-${log.id}`}>
                                    Received {new Date(receivedAt).toLocaleString()}
                                  </p>
                                )}
                              </>
                            ) : (
                              <>
                                <p className="text-[10px] text-foreground/70 mt-1 font-medium">{log.carrierNames.join(", ")}</p>
                                {log.sentAt && <p className="text-[9px] text-muted-foreground mt-0.5">Sent {new Date(log.sentAt).toLocaleString()}</p>}
                                {!log.sentAt && <p className="text-[9px] text-muted-foreground mt-0.5">Logged {new Date(log.timestamp).toLocaleString()}</p>}
                                {log.replyReceivedAt && (
                                  <p className="text-[9px] text-blue-400/80 mt-0.5" data-testid={`reply-timestamp-${log.id}`}>
                                    Reply received {new Date(log.replyReceivedAt).toLocaleString()}
                                  </p>
                                )}
                                {log.replySnippet && (
                                  <p className="text-[9px] text-muted-foreground mt-0.5 italic truncate" data-testid={`reply-snippet-${log.id}`}>
                                    "{log.replySnippet}"
                                  </p>
                                )}
                                {log.failureReason && <p className="text-[9px] text-red-400/70 mt-0.5">Error: {log.failureReason}</p>}
                              </>
                            )}
                          </div>
                          {!isInbound && (
                            <div className="flex items-center gap-1.5 shrink-0">
                              {correctedOutreachIds.has(log.id) && (
                                <span className="flex items-center gap-0.5 text-[9px] text-emerald-400" data-testid={`badge-corrected-outreach-${log.id}`}>
                                  <Check className="w-2.5 h-2.5" /> Corrected
                                </span>
                              )}
                              {canCorrectEmails && !correctedOutreachIds.has(log.id) && status === "sent" && log.emailDrafts && log.emailDrafts.length > 0 && (
                                <button
                                  className="p-0.5 rounded hover:bg-amber-500/20 text-muted-foreground hover:text-amber-400 transition-colors"
                                  title="Correct this outreach — teach AI what should have been said"
                                  onClick={() => {
                                    const firstDraft = log.emailDrafts![0];
                                    setCorrectionLog(log);
                                    setCorrectionDraft(firstDraft);
                                    setCorrectedText(firstDraft.body);
                                    setCorrectionNotes("");
                                  }}
                                  data-testid={`button-correct-outreach-${log.id}`}
                                >
                                  <PenLine className="w-3 h-3" />
                                </button>
                              )}
                              <span className="text-[9px] text-muted-foreground">{log.carrierNames.length} carrier{log.carrierNames.length !== 1 ? "s" : ""}</span>
                            </div>
                          )}
                        </div>
                        {!isInbound && log.recipients && log.recipients.length > 0 && (
                          <div className="mt-2 flex flex-col gap-1">
                            {log.recipients.map((r, ri) => {
                              const isAdHoc = r.carrierId === null && r.carrierName.startsWith("Ad-hoc:");
                              const displayName = isAdHoc ? (r.email ?? r.carrierName) : r.carrierName;
                              return (
                                <div key={ri} className="flex items-center gap-2 text-[9px] flex-wrap">
                                  {isAdHoc && <span className="px-1 py-0.5 rounded bg-blue-500/15 border border-blue-500/25 text-blue-400">Ad-hoc</span>}
                                  <span className="text-muted-foreground">{displayName}</span>
                                  {r.status === "sent" && <span className="text-emerald-400 flex items-center gap-0.5"><CheckCircle2 className="w-2 h-2" /> sent</span>}
                                  {r.status === "failed" && <span className="text-red-400 flex items-center gap-0.5"><XCircle className="w-2 h-2" /> {r.error ?? "failed"}</span>}
                                  {r.status === "no_email" && <span className="text-orange-400">no email on file</span>}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {!isInbound && log.emailDrafts && log.emailDrafts.length > 0 && (
                          <div className="mt-2 flex flex-col gap-0.5">
                            {log.emailDrafts.map((d, di) => (
                              <p key={di} className="text-[9px] text-muted-foreground truncate">
                                <span className="text-muted-foreground/30">Subject:</span> {d.subject}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <Dialog open={bulkEditOpen} onOpenChange={setBulkEditOpen}>
            <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto" data-testid="bulk-edit-modal">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-base">
                  <PenLine className="w-5 h-5 text-amber-500" />
                  Edit & Apply to All
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-1">
                  Edit the subject and body below. When you approve, all {emailDrafts.length} drafts will be updated with this content, with each carrier's name substituted automatically.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 mt-2">
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Subject</label>
                  <input
                    type="text"
                    value={bulkEditSubject}
                    onChange={e => setBulkEditSubject(e.target.value)}
                    className="w-full text-[11px] text-foreground/70 bg-muted/20 border border-border rounded px-2 py-1.5 focus:outline-none focus:border-amber-400/40"
                    data-testid="bulk-edit-subject"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Body</label>
                  <Textarea
                    value={bulkEditBody}
                    onChange={e => setBulkEditBody(e.target.value)}
                    className="text-[11px] text-foreground/70 bg-muted/20 border-border resize-none min-h-[200px]"
                    data-testid="bulk-edit-body"
                  />
                </div>
              </div>
              <DialogFooter className="mt-4">
                <Button variant="outline" size="sm" onClick={() => setBulkEditOpen(false)} data-testid="bulk-edit-cancel">
                  Cancel
                </Button>
                <Button size="sm" onClick={handleBulkApproveAndApply} className="bg-amber-600 hover:bg-amber-700 text-white" data-testid="bulk-edit-approve">
                  Approve & Apply to All
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={!!correctionLog && !!correctionDraft} onOpenChange={(o) => { if (!o) { setCorrectionLog(null); setCorrectionDraft(null); } }}>
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="carrier-correction-modal">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-base">
                  <PenLine className="w-5 h-5 text-amber-500" />
                  Correct Carrier Outreach
                </DialogTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  Edit what we should have said. AI will learn from this correction for future carrier outreach.
                </p>
              </DialogHeader>

              {correctionLog && correctionDraft && (
                <div className="space-y-4 mt-2">
                  {correctionLog.emailDrafts && correctionLog.emailDrafts.length > 1 && (
                    <div className="flex flex-wrap gap-1">
                      {correctionLog.emailDrafts.map((d, di) => (
                        <button
                          key={di}
                          onClick={() => {
                            setCorrectionDraft(d);
                            setCorrectedText(d.body);
                          }}
                          className={`px-2 py-1 rounded text-[10px] border transition-colors ${
                            correctionDraft.carrierName === d.carrierName
                              ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                              : "bg-muted/20 border-border text-muted-foreground hover:border-foreground/30"
                          }`}
                          data-testid={`tab-draft-${di}`}
                        >
                          {d.carrierName}
                        </button>
                      ))}
                    </div>
                  )}

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-muted-foreground">Original (what was sent)</label>
                      <span className="text-[10px] text-muted-foreground">To: {correctionDraft.carrierName}</span>
                    </div>
                    <div className="rounded-lg border bg-muted/30 p-3 text-xs whitespace-pre-wrap max-h-40 overflow-y-auto" data-testid="text-original-outreach">
                      <p className="text-muted-foreground/60 mb-1">Subject: {correctionDraft.subject}</p>
                      {correctionDraft.body}
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">
                      Corrected version (what we should have said)
                    </label>
                    <Textarea
                      value={correctedText}
                      onChange={(e) => setCorrectedText(e.target.value)}
                      className="min-h-[140px] text-sm"
                      placeholder="Rewrite the email the way it should have been sent..."
                      data-testid="textarea-corrected-outreach"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">
                      Coaching notes (optional)
                    </label>
                    <Textarea
                      value={correctionNotes}
                      onChange={(e) => setCorrectionNotes(e.target.value)}
                      className="h-16 text-sm resize-none"
                      placeholder="Why is this better? (e.g., 'too generic, should mention their equipment type', 'rate was wrong')"
                      data-testid="textarea-correction-notes-outreach"
                    />
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setCorrectionLog(null); setCorrectionDraft(null); }}
                      data-testid="button-cancel-carrier-correction"
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="gap-1"
                      disabled={outreachCorrectionMutation.isPending || correctedText.trim() === correctionDraft.body.trim()}
                      onClick={() => {
                        outreachCorrectionMutation.mutate({
                          outreachLogId: correctionLog.id,
                          originalText: correctionDraft.body,
                          correctedText: correctedText.trim(),
                          correctionNotes: correctionNotes.trim() || undefined,
                          subject: correctionDraft.subject,
                          carrierId: correctionDraft.carrierId ?? undefined,
                        });
                      }}
                      data-testid="button-submit-carrier-correction"
                    >
                      {outreachCorrectionMutation.isPending ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Check className="w-3.5 h-3.5" />
                      )}
                      Save Correction
                    </Button>
                  </div>
                </div>
              )}
            </DialogContent>
          </Dialog>
        </div>

        {/* ── CONTEXT-AWARE STICKY FOOTER ──────────────────────────────── */}
        {(activeMainTab === "carriers" || activeMainTab === "message") && (
          <div className="fixed bottom-0 right-0 w-full sm:max-w-2xl bg-background/95 backdrop-blur border-t border-border px-5 py-3 flex gap-2 z-50">

            {/* Carriers / Ranked footer */}
            {activeMainTab === "carriers" && activeCarriersSubTab === "ranked" && (
              <>
                <Button
                  size="sm"
                  onClick={handleGenerateOutreach}
                  disabled={(selectedCarriers.size === 0 && adHocParsed.valid.length === 0) || draftEmailsMutation.isPending}
                  className="flex-1 h-9 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold disabled:opacity-50"
                  data-testid="btn-generate-outreach"
                >
                  {draftEmailsMutation.isPending ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />Generating drafts…</>
                  ) : (selectedCarriers.size > 0 || adHocParsed.valid.length > 0) ? (
                    <><Mail className="w-3.5 h-3.5 mr-1.5" />Review Message ({selectedCarriers.size + adHocParsed.valid.length} selected) →</>
                  ) : (
                    <><Mail className="w-3.5 h-3.5 mr-1.5" />Select Carriers to Continue</>
                  )}
                </Button>
                {selectedCarriers.size > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleLogOutreach}
                    disabled={outreachLogMutation.isPending}
                    className="h-9 text-xs border-border text-muted-foreground hover:bg-muted/20"
                    data-testid="btn-mark-contacted"
                  >
                    {outreachLogMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ClipboardCheck className="w-3.5 h-3.5" />}
                    <span className="ml-1.5">Log Only</span>
                  </Button>
                )}
              </>
            )}

            {/* Carriers / Bench or Import footer — informational */}
            {activeMainTab === "carriers" && activeCarriersSubTab !== "ranked" && (
              <p className="text-[10px] text-muted-foreground w-full text-center">
                {activeCarriersSubTab === "bench"
                  ? "Bench tracks carriers contacted on this lane."
                  : "Import carriers to add them to the bench."}
              </p>
            )}

            {/* Message tab footer */}
            {activeMainTab === "message" && (
              <>
                {showEmails && emailDrafts.length > 0 && sendOverallStatus === "idle" && (
                  <>
                    <Button
                      size="sm"
                      onClick={() => {
                        if (emailDrafts.length >= 50) {
                          setSendConfirmOpen(true);
                          setSendConfirmOverride(false);
                        } else {
                          handleSendOutreach();
                        }
                      }}
                      disabled={sendOutreachMutation.isPending}
                      className="flex-1 h-9 text-sm bg-blue-600 hover:bg-blue-500 text-foreground font-semibold"
                      data-testid="btn-send-emails"
                    >
                      {sendOutreachMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Send className="w-3.5 h-3.5 mr-1.5" />}
                      Send Emails ({emailDrafts.length})
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleLogOutreach}
                      disabled={outreachLogMutation.isPending}
                      className="h-9 text-xs border-border text-muted-foreground hover:bg-muted/20"
                      data-testid="btn-log-without-sending"
                    >
                      {outreachLogMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ClipboardCheck className="w-3.5 h-3.5" />}
                      <span className="ml-1.5">Log Only</span>
                    </Button>
                  </>
                )}
                {!showEmails && (selectedCarriers.size > 0 || adHocParsed.valid.length > 0) && (
                  <Button
                    size="sm"
                    onClick={handleGenerateOutreach}
                    disabled={draftEmailsMutation.isPending}
                    className="flex-1 h-9 text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold"
                    data-testid="btn-generate-outreach"
                  >
                    {draftEmailsMutation.isPending ? (
                      <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />Generating…</>
                    ) : (
                      <><Mail className="w-3.5 h-3.5 mr-1.5" />Generate Drafts ({selectedCarriers.size + adHocParsed.valid.length})</>
                    )}
                  </Button>
                )}
                {!showEmails && selectedCarriers.size === 0 && adHocParsed.valid.length === 0 && (
                  <p className="text-[10px] text-muted-foreground w-full text-center">Select carriers first to generate outreach drafts.</p>
                )}
                {sendOverallStatus === "done" && (() => {
                  const sentCt = Object.values(draftSendStatus).filter(s => s === "sent").length;
                  if (sentCt > 0) {
                    return (
                      <div className="flex-1 flex items-center justify-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span className="text-sm text-emerald-400 font-medium">Outreach complete</span>
                      </div>
                    );
                  }
                  return (
                    <div className="flex-1 flex items-center justify-center gap-1.5">
                      <AlertCircle className="w-4 h-4 text-orange-400" />
                      <span className="text-sm text-orange-400 font-medium">No emails sent — check carrier email addresses</span>
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        )}

        {/* Bulk send confirmation dialog (50+ carriers warning) */}
        {sendConfirmOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70" data-testid="send-confirm-dialog">
            <div className="bg-card border border-border rounded-xl p-5 max-w-sm w-full mx-4 shadow-2xl">
              <div className="flex items-center gap-2 mb-3">
                <AlertCircle className="w-5 h-5 text-orange-400 shrink-0" />
                <p className="text-sm font-semibold text-foreground">Send to {emailDrafts.length} carriers?</p>
              </div>
              <p className="text-xs text-muted-foreground mb-4">
                You are about to send outreach emails to <span className="text-orange-300 font-medium">{emailDrafts.length} carriers</span>. This is a large batch — confirm you want to proceed.
              </p>
              <div className="flex items-center gap-2 mb-4 p-2 bg-muted/20 border border-border rounded-lg">
                <input
                  type="checkbox"
                  id="override-recently-contacted"
                  checked={sendConfirmOverride}
                  onChange={e => setSendConfirmOverride(e.target.checked)}
                  className="w-3.5 h-3.5 accent-amber-400"
                  data-testid="chk-override-recently-contacted"
                />
                <label htmlFor="override-recently-contacted" className="text-[11px] text-muted-foreground cursor-pointer">
                  Include recently-contacted carriers (override 14-day suppression)
                </label>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setSendConfirmOpen(false)} className="flex-1 h-8 text-xs border-border text-muted-foreground hover:bg-muted/20" data-testid="btn-cancel-bulk-send">
                  Cancel
                </Button>
                <Button size="sm"
                  onClick={() => {
                    setSendConfirmOpen(false);
                    if (sendConfirmOverride) setOverrideRecentlyContacted(true);
                    handleSendOutreach();
                  }}
                  className="flex-1 h-8 text-xs bg-blue-600 hover:bg-blue-500 text-foreground font-semibold"
                  data-testid="btn-confirm-bulk-send"
                >
                  <Send className="w-3 h-3 mr-1" /> Confirm Send
                </Button>
              </div>
            </div>
          </div>
        )}
      </SheetContent>
      {/* Task #638 — Carrier override reason picker. Lives outside the sheet so
          its dismiss path (overlay click / Esc) doesn't tear down panel state. */}
      <CarrierOverrideReasonPicker
        open={!!overridePicker}
        onOpenChange={(o) => { if (!o) setOverridePicker(null); }}
        carrier={overridePicker?.carrier ?? null}
        lane={overridePicker?.lane ?? {}}
        action={overridePicker?.action ?? "deselect_top3"}
      />
    </Sheet>
  );
}
