/**
 * CarrierOutreachPanel
 *
 * Side panel for the "Lock In Capacity on [Origin → Destination]" NBA card.
 * Lets NAMs/AMs/LMs:
 *   1. See the lane details + lane score
 *   2. Browse AI-ranked carrier suggestions
 *   3. Draft lane-building outreach emails
 *   4. Mark carriers as contacted (triggers outreach log)
 *   5. Classify carrier replies
 *   6. Receive follow-up suggestions
 *   7. Switch between "Lane-Building" and "Immediate + Lane" outreach modes
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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
  ArrowRight,
  Truck,
  Star,
  Mail,
  CheckCircle2,
  RefreshCw,
  Lightbulb,
  ClipboardCheck,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Loader2,
  User,
  UserCheck,
  Send,
  XCircle,
  Clock,
  History,
  Copy,
  Upload,
  Plus,
  ExternalLink,
} from "lucide-react";
import { Input } from "@/components/ui/input";

// ── Types ────────────────────────────────────────────────────────────────────

interface RecurringLane {
  id: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  avgLoadsPerWeek: string | null;
  weeksActive: number | null;
  lookbackWeeks: number | null;
  laneScore: number | null;
  eligibilityConfidence: string;
  companyId: string | null;
  companyName: string | null;
  carriersContactedCount: number | null;
  hasPreferredCarrierProgram: boolean;
  resolvedAt: string | null;
  ownerUserId: string | null;
  overseerUserId: string | null;
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
}

interface RankedCarrier {
  carrierId: string | null;
  carrierName: string;
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
  manual: "border-slate-500/40 text-slate-400",
  engine: "border-blue-500/40 text-blue-400",
  excel_seed: "border-emerald-500/40 text-emerald-400",
  other: "border-white/20 text-white/40",
};

interface EmailDraft {
  carrierId: string | null;
  carrierName: string;
  subject: string;
  body: string;
  outreachMode: string;
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
  }> | null;
  emailDrafts: EmailDraft[] | null;
}

type PerDraftSendStatus = "idle" | "sending" | "sent" | "failed" | "no_email";

// ── Constants ────────────────────────────────────────────────────────────────

const INTEREST_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  available_now:      { label: "Available Now",    color: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  available_next_week:{ label: "Next Week",         color: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30" },
  future_interest:    { label: "Future Interest",   color: "bg-violet-500/20 text-violet-300 border-violet-500/30" },
  not_fit:            { label: "Not a Fit",         color: "bg-red-500/20 text-red-300 border-red-500/30" },
  needs_follow_up:    { label: "Needs Follow-up",   color: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
};

const HISTORY_MATCH_LABELS: Record<string, string> = {
  exact:   "Ran this lane",
  similar: "Similar corridor",
  region:  "In region",
  none:    "New prospect",
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
  // If no laneId given, resolve it from the company's best recurring lane
  const { data: companyLanes } = useQuery<RecurringLane[]>({
    queryKey: ["/api/recurring-lanes"],
    queryFn: () => fetch("/api/recurring-lanes").then(r => r.json()),
    enabled: !laneIdProp && !!companyId && open,
  });

  const laneId = laneIdProp ?? (
    companyId
      ? (companyLanes ?? [])
          // IMPORTANT: filter by companyId to avoid showing outreach for wrong account
          .filter(l => l.companyId === companyId && !l.resolvedAt && !l.hasPreferredCarrierProgram)
          .sort((a, b) => (b.laneScore ?? 0) - (a.laneScore ?? 0))[0]?.id ?? null
      : null
  );

  const { data: outreachConfig } = useQuery<{ completionCarriersContacted: number }>({
    queryKey: ["/api/lane-outreach-config"],
    queryFn: () => fetch("/api/lane-outreach-config").then(r => r.json()),
    staleTime: 5 * 60 * 1000,
  });
  const completionThreshold = outreachConfig?.completionCarriersContacted ?? 3;

  const { data: teamMembers = [] } = useQuery<TeamMember[]>({
    queryKey: ["/api/team-members"],
    queryFn: () => fetch("/api/team-members").then(r => r.json()),
    enabled: open,
  });
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuth();
  const isDirectorOrAdmin = ["admin", "director"].includes(currentUser?.role ?? "");
  const isManager = ["admin", "director", "national_account_manager", "logistics_manager"].includes(currentUser?.role ?? "");

  const [selectedCarriers, setSelectedCarriers] = useState<Set<string>>(new Set());
  const [outreachMode, setOutreachMode] = useState<"lane_building" | "immediate_plus_lane">("lane_building");
  const [emailDrafts, setEmailDrafts] = useState<EmailDraft[]>([]);
  const [showEmails, setShowEmails] = useState(false);
  const [replyInputs, setReplyInputs] = useState<Record<string, string>>({});
  const [expandedReply, setExpandedReply] = useState<string | null>(null);
  // Per-draft send status (keyed by index)
  const [draftSendStatus, setDraftSendStatus] = useState<Record<number, PerDraftSendStatus>>({});
  const [sendOverallStatus, setSendOverallStatus] = useState<"idle" | "sending" | "done">("idle");
  // Carrier suggestion filters
  const [activeOnly, setActiveOnly] = useState(false);
  const [excludeServiceFlags, setExcludeServiceFlags] = useState(false);
  // Inline email notes per carrier (keyed by carrierId ?? carrierName)
  const [inlineEmails, setInlineEmails] = useState<Record<string, string>>({});
  // User-entered email addresses for carriers that have no primaryEmail in the catalog
  const [capturedEmails, setCapturedEmails] = useState<Record<string, string>>({});
  // Shared outreach template that applies to all selected carriers
  const [sharedTemplate, setSharedTemplate] = useState("");
  // ── Import tab state ──────────────────────────────────────────────────────
  const [importPasteText, setImportPasteText] = useState("");
  const [importSource, setImportSource] = useState("dat");
  const [parsedImportCarriers, setParsedImportCarriers] = useState<ParsedImportCarrier[] | null>(null);
  const [importResults, setImportResults] = useState<ImportResult[] | null>(null);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const { data: lane, isLoading: laneLoading } = useQuery<RecurringLane>({
    queryKey: ["/api/recurring-lanes", laneId],
    queryFn: () => fetch(`/api/recurring-lanes/${laneId}`).then(r => r.json()),
    enabled: !!laneId && open,
  });

  const { data: suggestionsData, isLoading: suggestionsLoading } = useQuery<{ carriers: RankedCarrier[] }>({
    queryKey: ["/api/lanes", laneId, "carrier-suggestions"],
    queryFn: () => fetch(`/api/lanes/${laneId}/carrier-suggestions`).then(r => r.json()),
    enabled: !!laneId && open,
  });

  const { data: bench = [], refetch: refetchBench } = useQuery<CarrierInterest[]>({
    queryKey: ["/api/lanes", laneId, "carrier-bench"],
    queryFn: () => fetch(`/api/lanes/${laneId}/carrier-bench`).then(r => r.json()),
    enabled: !!laneId && open,
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
      refetchBench();
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes", laneId] });
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: "Lane assigned" });
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
    onSuccess: (data: { results: Array<{ carrierId: string | null; carrierName: string; email: string | null; status: string; error?: string }>; sentCount: number; failedCount: number; carriersContactedCount: number; resolved: boolean }) => {
      // Map results back to per-draft statuses
      const newStatuses: Record<number, PerDraftSendStatus> = {};
      emailDrafts.forEach((draft, idx) => {
        const r = data.results.find(r => r.carrierName === draft.carrierName);
        newStatuses[idx] = (r?.status as PerDraftSendStatus) ?? "idle";
      });
      setDraftSendStatus(newStatuses);
      setSendOverallStatus("done");
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes", laneId] });
      queryClient.invalidateQueries({ queryKey: ["/api/lanes", laneId, "carrier-bench"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lanes", laneId, "outreach-history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/nba/cards"] });
      refetchBench();
      if (data.resolved) {
        onCarriersContacted?.();
        toast({ title: "Lane bench complete!", description: "Carrier emails sent — bench resolved. Snoozing 30 days." });
      } else if (data.failedCount === 0) {
        toast({ title: `${data.sentCount} email${data.sentCount > 1 ? "s" : ""} sent!`, description: "Outreach logged to lane history." });
      } else if (data.sentCount > 0) {
        toast({ title: `${data.sentCount} sent, ${data.failedCount} failed`, description: "Check per-carrier status below.", variant: "destructive" });
      } else {
        toast({ title: "All sends failed", description: data.results.map(r => r.error).filter(Boolean).join("; "), variant: "destructive" });
      }
    },
    onError: () => {
      setSendOverallStatus("idle");
      toast({ title: "Send failed", description: "Could not reach the email service. Verify configuration.", variant: "destructive" });
    },
  });

  const { data: outreachHistory = [], refetch: refetchHistory } = useQuery<OutreachLog[]>({
    queryKey: ["/api/lanes", laneId, "outreach-history"],
    queryFn: () => fetch(`/api/lanes/${laneId}/outreach-log`).then(r => r.json()),
    enabled: !!laneId && open,
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
    },
    onError: () => {
      toast({ title: "Import failed", description: "Could not import carriers. Please try again.", variant: "destructive" });
    },
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  const rankedCarriers = suggestionsData?.carriers ?? [];

  // Apply frontend filters
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  const filteredCarriers = rankedCarriers.filter(c => {
    if (activeOnly) {
      if (!c.lastUsedMonth) return false;
      const lastDate = new Date(c.lastUsedMonth + "-01");
      if (Date.now() - lastDate.getTime() > NINETY_DAYS_MS) return false;
    }
    if (excludeServiceFlags) {
      const flagTags = ["do_not_use", "service_flag", "flagged", "no_use"];
      if (c.tags.some(t => flagTags.includes(t.toLowerCase()))) return false;
    }
    return true;
  });

  function toggleCarrier(c: RankedCarrier) {
    setSelectedCarriers(prev => {
      const next = new Set(prev);
      const key = c.carrierId ?? c.carrierName;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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

  function handleGenerateOutreach() {
    const selected = filteredCarriers.filter(c => selectedCarriers.has(c.carrierId ?? c.carrierName));
    if (selected.length === 0) {
      toast({ title: "Select at least one carrier first" });
      return;
    }
    // If user has provided a shared template, apply it to all selected carriers directly
    // (skip AI drafting — the shared template IS the email body, personalized only by carrier name)
    if (sharedTemplate.trim()) {
      const origin = lane ? `${lane.origin}${lane.originState ? ", " + lane.originState : ""}` : "";
      const dest = lane ? `${lane.destination}${lane.destinationState ? ", " + lane.destinationState : ""}` : "";
      const equipment = lane?.equipmentType ?? "dry van";
      const drafts: EmailDraft[] = selected.map(c => ({
        carrierId: c.carrierId,
        carrierName: c.carrierName,
        subject: `Lane-Building Opportunity: ${origin} → ${dest} (${equipment})`,
        body: sharedTemplate.trim(),
        outreachMode,
      }));
      setEmailDrafts(drafts);
      setShowEmails(true);
      return;
    }
    draftEmailsMutation.mutate({
      carrierIds: selected.map(c => c.carrierId),
      carrierNames: selected.map(c => c.carrierName),
      outreachMode,
    });
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
    const origin = `${l.origin}${l.originState ? ", " + l.originState : ""}`;
    const dest = `${l.destination}${l.destinationState ? ", " + l.destinationState : ""}`;
    return `${origin} → ${dest}`;
  }

  const contactedCount = lane?.carriersContactedCount ?? 0;
  const progressPct = Math.min(100, (contactedCount / completionThreshold) * 100);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl bg-slate-900 border-white/10 text-white overflow-y-auto p-0"
        data-testid="carrier-outreach-panel"
      >
        {/* Header */}
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-white/8">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-amber-500/20 flex items-center justify-center">
              <Truck className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <SheetTitle className="text-sm font-semibold text-white leading-tight">
                Lock In Capacity
              </SheetTitle>
              {lane && (
                <SheetDescription className="text-xs text-white/50 mt-0.5">
                  {laneLabel(lane)} · {lane.equipmentType ?? "Any Equipment"}
                </SheetDescription>
              )}
            </div>
          </div>

          {/* Lane stats */}
          {lane && (
            <div className="flex gap-3 mt-3 flex-wrap">
              <div className="flex flex-col">
                <span className="text-[10px] text-white/40 uppercase tracking-wide">Avg Loads/Week</span>
                <span className="text-sm font-semibold text-white">{lane.avgLoadsPerWeek ?? "—"}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-white/40 uppercase tracking-wide">Weeks Active</span>
                <span className="text-sm font-semibold text-white">{lane.weeksActive ?? "—"}/{lane.lookbackWeeks ?? 4}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-white/40 uppercase tracking-wide">Lane Score</span>
                <span className="text-sm font-semibold text-white">{lane.laneScore ?? "—"}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-white/40 uppercase tracking-wide">Confidence</span>
                <Badge variant="outline" className={`text-[10px] py-0 px-1.5 capitalize
                  ${lane.eligibilityConfidence === "high" ? "border-emerald-500/40 text-emerald-300" :
                    lane.eligibilityConfidence === "medium" ? "border-amber-500/40 text-amber-300" :
                    "border-slate-500/40 text-slate-300"}`}>
                  {lane.eligibilityConfidence}
                </Badge>
              </div>
            </div>
          )}

          {/* Outreach progress */}
          {lane && (
            <div className="mt-2">
              <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] text-white/40">Carriers Contacted</span>
                <span className="text-[10px] text-white/60">{contactedCount}/{completionThreshold}</span>
              </div>
              <div className="h-1.5 rounded-full bg-white/8">
                <div
                  className="h-1.5 rounded-full bg-amber-400 transition-all"
                  style={{ width: `${progressPct}%` }}
                  data-testid="outreach-progress-bar"
                />
              </div>
            </div>
          )}

          {/* Contactability warning — no carriers with phone/email */}
          {lane && bench.length > 0 && bench.every(b => !b.isContactable) && (
            <div className="mt-2 flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-md px-3 py-2"
              data-testid="no-contactable-carriers-warning">
              <AlertCircle className="w-3.5 h-3.5 text-orange-400 shrink-0" />
              <p className="text-[11px] text-orange-300">
                No carriers on this bench have a phone or email on file.
                Add contact details in the Carriers catalog to enable outreach.
              </p>
            </div>
          )}

          {/* Owner / Overseer chips */}
          {lane && (
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {/* Unassigned state — show assign button for managers */}
              {!lane.ownerUserId && isManager && (
                <div className="flex items-center gap-1.5" data-testid="chip-lane-unassigned">
                  <span className="text-[11px] text-white/30 italic">No owner assigned</span>
                  {currentUser && (
                    <button
                      onClick={() => assignLaneMutation.mutate(currentUser.id)}
                      disabled={assignLaneMutation.isPending}
                      className="text-[10px] px-2 py-0.5 rounded-full border border-blue-400/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 transition-colors"
                      data-testid="btn-assign-to-me"
                    >
                      {assignLaneMutation.isPending ? "Assigning…" : "Assign to me"}
                    </button>
                  )}
                  {isDirectorOrAdmin && (
                    <Select onValueChange={v => assignLaneMutation.mutate(v)}>
                      <SelectTrigger className="h-6 w-auto text-[10px] bg-white/5 border-white/10 text-white/50" data-testid="btn-assign-select">
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
                return (
                  <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-full px-2 py-0.5"
                    data-testid="chip-lane-owner">
                    <User className="w-3 h-3 text-blue-300" />
                    <span className="text-[11px] text-white/70">Owner: {owner?.name ?? lane.ownerUserId}</span>
                    {isDirectorOrAdmin && (
                      <Select
                        value={lane.ownerUserId}
                        onValueChange={v => reassignMutation.mutate({ ownerUserId: v })}
                      >
                        <SelectTrigger className="h-4 w-4 p-0 border-0 bg-transparent text-white/40 hover:text-white/80"
                          data-testid="btn-reassign-owner">
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
              {lane.overseerUserId && lane.overseerUserId !== lane.ownerUserId && (() => {
                const overseer = teamMembers.find(m => m.id === lane.overseerUserId);
                return (
                  <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-full px-2 py-0.5"
                    data-testid="chip-lane-overseer">
                    <UserCheck className="w-3 h-3 text-violet-300" />
                    <span className="text-[11px] text-white/70">Overseer: {overseer?.name ?? lane.overseerUserId}</span>
                    {isDirectorOrAdmin && (
                      <Select
                        value={lane.overseerUserId ?? ""}
                        onValueChange={v => reassignMutation.mutate({ overseerUserId: v })}
                      >
                        <SelectTrigger className="h-4 w-4 p-0 border-0 bg-transparent text-white/40 hover:text-white/80"
                          data-testid="btn-reassign-overseer">
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
            </div>
          )}

          {/* Mode selector */}
          <div className="flex items-center gap-2 mt-3">
            <span className="text-[10px] text-white/40 shrink-0">Outreach Mode:</span>
            <Select
              value={outreachMode}
              onValueChange={(v: "lane_building" | "immediate_plus_lane") => setOutreachMode(v)}
            >
              <SelectTrigger
                className="h-7 text-xs bg-white/5 border-white/10 text-white/80 flex-1"
                data-testid="outreach-mode-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-white/10 text-white">
                <SelectItem value="lane_building" className="text-xs">Lane-Building (recurring framing)</SelectItem>
                <SelectItem value="immediate_plus_lane" className="text-xs">Immediate Load + Lane Building</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </SheetHeader>

        {/* Body */}
        <Tabs defaultValue="carriers" className="flex flex-col flex-1">
          <TabsList className="w-full rounded-none bg-white/4 border-b border-white/8 h-9 px-5 gap-0 justify-start">
            <TabsTrigger value="carriers" className="text-xs h-full rounded-none px-3 data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-amber-400 data-[state=active]:text-white" data-testid="tab-carriers">
              Carrier Suggestions
            </TabsTrigger>
            <TabsTrigger value="bench" className="text-xs h-full rounded-none px-3 data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-amber-400 data-[state=active]:text-white" data-testid="tab-bench">
              Bench {bench.length > 0 ? `(${bench.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="import" className="text-xs h-full rounded-none px-3 data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-amber-400 data-[state=active]:text-white" data-testid="tab-import">
              <Upload className="w-3 h-3 mr-1" />
              Import
            </TabsTrigger>
            <TabsTrigger value="followup" className="text-xs h-full rounded-none px-3 data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-amber-400 data-[state=active]:text-white" data-testid="tab-followup">
              Follow-up
            </TabsTrigger>
            <TabsTrigger value="history" className="text-xs h-full rounded-none px-3 data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-amber-400 data-[state=active]:text-white" data-testid="tab-history">
              History {outreachHistory.length > 0 ? `(${outreachHistory.length})` : ""}
            </TabsTrigger>
          </TabsList>

          {/* ── Carrier Suggestions Tab ─────────────────────────────────── */}
          <TabsContent value="carriers" className="flex-1 px-5 pt-4 pb-20 overflow-y-auto">
            {/* Filter toggles */}
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <button
                onClick={() => setActiveOnly(v => !v)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  activeOnly ? "bg-blue-500/20 border-blue-400/40 text-blue-300" : "bg-white/4 border-white/10 text-white/40 hover:border-white/20"
                }`}
                data-testid="toggle-active-90-days"
              >
                Active (90 days)
              </button>
              <button
                onClick={() => setExcludeServiceFlags(v => !v)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  excludeServiceFlags ? "bg-red-500/20 border-red-400/40 text-red-300" : "bg-white/4 border-white/10 text-white/40 hover:border-white/20"
                }`}
                data-testid="toggle-exclude-service-flags"
              >
                Exclude Flagged
              </button>
              {(activeOnly || excludeServiceFlags) && rankedCarriers.length !== filteredCarriers.length && (
                <span className="text-[10px] text-white/30">{filteredCarriers.length}/{rankedCarriers.length} shown</span>
              )}
            </div>

            {suggestionsLoading && (
              <div className="flex items-center gap-2 text-white/40 text-xs py-4">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading carrier suggestions…
              </div>
            )}

            {!suggestionsLoading && filteredCarriers.length === 0 && (
              <div className="text-xs text-white/40 py-4">
                {rankedCarriers.length === 0
                  ? "No carriers in catalog yet. Add carriers in the Carriers admin tab to get AI rankings."
                  : "No carriers match the active filters."}
              </div>
            )}

            <div className="flex flex-col gap-2">
              {filteredCarriers.map((c, idx) => {
                const key = c.carrierId ?? c.carrierName;
                const isSelected = selectedCarriers.has(key);
                return (
                  <div key={key} className="flex flex-col">
                    <button
                      onClick={() => toggleCarrier(c)}
                      className={`text-left p-3 rounded-lg border transition-colors ${
                        isSelected
                          ? "bg-amber-500/10 border-amber-500/30"
                          : "bg-white/3 border-white/8 hover:bg-white/6"
                      }`}
                      data-testid={`carrier-suggestion-${idx}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-semibold text-white truncate">{c.carrierName}</span>
                            {c.isNewProspect && (
                              <Badge variant="outline" className="text-[9px] py-0 px-1 border-slate-500/40 text-slate-400">New Prospect</Badge>
                            )}
                            <Badge variant="outline" className="text-[9px] py-0 px-1 border-white/15 text-white/40">
                              {HISTORY_MATCH_LABELS[c.historyMatch] ?? c.historyMatch}
                            </Badge>
                            {c.sourceChannel && SOURCE_LABELS[c.sourceChannel] && (
                              <Badge variant="outline" className={`text-[9px] py-0 px-1 ${SOURCE_COLORS[c.sourceChannel] ?? "border-white/20 text-white/40"}`}>
                                {SOURCE_LABELS[c.sourceChannel]}
                              </Badge>
                            )}
                            {!c.primaryEmail && !capturedEmails[c.carrierId ?? c.carrierName] && (
                              <Badge variant="outline" className="text-[9px] py-0 px-1 border-orange-500/40 text-orange-400 flex items-center gap-0.5">
                                <Mail className="w-2.5 h-2.5" />
                                No email on file
                              </Badge>
                            )}
                          </div>
                          <p className="text-[10px] text-white/50 mt-0.5 line-clamp-2">{c.fitReason}</p>
                          {(c.regions.length > 0 || c.equipmentTypes.length > 0) && (
                            <p className="text-[10px] text-white/30 mt-0.5">
                              {[...c.regions, ...c.equipmentTypes].slice(0, 4).join(" · ")}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-col items-end shrink-0">
                          <div className={`text-xs font-bold ${c.fitScore >= 70 ? "text-emerald-400" : c.fitScore >= 45 ? "text-amber-400" : "text-white/50"}`}>
                            {c.fitScore}
                          </div>
                          <div className="text-[9px] text-white/30">fit</div>
                          {isSelected && (
                            <CheckCircle2 className="w-3.5 h-3.5 text-amber-400 mt-1" />
                          )}
                        </div>
                      </div>
                    </button>
                    {/* Inline email affordances — shown when carrier is selected */}
                    {isSelected && (
                      <div className="ml-3 mr-0 -mt-1 bg-amber-500/5 border border-amber-500/15 border-t-0 rounded-b-lg px-3 pb-2 pt-2 flex flex-col gap-2">
                        {/* Add email capture when no email on file */}
                        {!c.primaryEmail && (
                          <div>
                            <p className="text-[9px] text-orange-400/70 mb-1 uppercase tracking-wide flex items-center gap-1">
                              <Mail className="w-2.5 h-2.5" />
                              Add carrier email
                            </p>
                            <input
                              type="email"
                              value={capturedEmails[key] ?? ""}
                              onChange={e => setCapturedEmails(prev => ({ ...prev, [key]: e.target.value }))}
                              placeholder={`email@${c.carrierName.toLowerCase().replace(/\s+/g, "")}.com`}
                              className="w-full text-[11px] text-white/70 bg-white/5 border border-white/10 rounded px-2 py-1 placeholder:text-white/20 focus:outline-none focus:border-orange-400/40"
                              data-testid={`add-email-input-${idx}`}
                            />
                          </div>
                        )}
                        <div>
                          <p className="text-[9px] text-amber-300/60 mb-1 uppercase tracking-wide">Custom email note (optional)</p>
                          <Textarea
                            value={inlineEmails[key] ?? ""}
                            onChange={e => setInlineEmails(prev => ({ ...prev, [key]: e.target.value }))}
                            placeholder={`Add a personalized note for ${c.carrierName}…`}
                            className="text-[11px] text-white/70 bg-white/5 border-white/10 resize-none min-h-[60px] placeholder:text-white/20"
                            data-testid={`inline-email-${idx}`}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Shared Template Editor — shown when carriers are selected */}
            {selectedCarriers.size > 0 && (
              <div className="mt-4 bg-slate-800/60 rounded-lg border border-white/8 p-3">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[10px] font-semibold text-white/70 uppercase tracking-wide">
                    Shared Template (applies to all selected carriers)
                  </p>
                  {sharedTemplate.trim() && (
                    <button
                      onClick={() => setSharedTemplate("")}
                      className="text-[9px] text-white/30 hover:text-white/50"
                      data-testid="clear-shared-template"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <p className="text-[9px] text-white/30 mb-1.5">
                  Enter a shared body for all selected carriers. Leave blank to let AI draft individual emails.
                </p>
                <Textarea
                  value={sharedTemplate}
                  onChange={e => setSharedTemplate(e.target.value)}
                  placeholder={`Hi [Carrier Name], I wanted to reach out about a recurring lane we run consistently…`}
                  className="text-[11px] text-white/70 bg-white/5 border-white/10 resize-none min-h-[80px] placeholder:text-white/20"
                  data-testid="shared-template-editor"
                />
                {sharedTemplate.trim() && (
                  <p className="text-[9px] text-emerald-400/70 mt-1 flex items-center gap-1">
                    <CheckCircle2 className="w-2.5 h-2.5" />
                    This template will be applied to {selectedCarriers.size} carrier(s) instead of AI drafting
                  </p>
                )}
              </div>
            )}

            {/* Email Drafts Section */}
            {showEmails && emailDrafts.length > 0 && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-semibold text-white/80">Drafted Emails ({emailDrafts.length})</p>
                    {sendOverallStatus === "done" && (
                      <span className="text-[9px] text-emerald-400 flex items-center gap-0.5">
                        <CheckCircle2 className="w-2.5 h-2.5" /> Sent
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => navigator.clipboard.writeText(emailDrafts.map(d => `To: ${d.carrierName}\nSubject: ${d.subject}\n\n${d.body}`).join("\n\n---\n\n"))}
                      className="text-[10px] text-white/30 hover:text-white/60 flex items-center gap-0.5"
                      data-testid="btn-copy-all-drafts"
                      title="Copy all drafts to clipboard"
                    >
                      <Copy className="w-2.5 h-2.5" /> Copy all
                    </button>
                    <button
                      onClick={() => setShowEmails(false)}
                      className="text-[10px] text-white/30 hover:text-white/60"
                    >
                      Hide
                    </button>
                  </div>
                </div>
                <div className="flex flex-col gap-3">
                  {emailDrafts.map((draft, i) => {
                    const status = draftSendStatus[i];
                    return (
                      <div key={i} className={`rounded-lg border p-3 ${
                        status === "sent" ? "bg-emerald-500/5 border-emerald-500/20" :
                        status === "failed" ? "bg-red-500/5 border-red-500/20" :
                        status === "no_email" ? "bg-orange-500/5 border-orange-500/20" :
                        "bg-white/4 border-white/8"
                      }`}>
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-[10px] font-semibold text-amber-300">{draft.carrierName}</p>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => navigator.clipboard.writeText(draft.body)}
                              className="text-[9px] text-white/30 hover:text-white/60"
                              title="Copy body"
                              data-testid={`btn-copy-draft-${i}`}
                            >
                              <Copy className="w-2.5 h-2.5" />
                            </button>
                            {status === "sent" && (
                              <span className="text-[9px] text-emerald-400 flex items-center gap-0.5" data-testid={`draft-status-sent-${i}`}>
                                <CheckCircle2 className="w-2.5 h-2.5" /> Sent
                              </span>
                            )}
                            {status === "failed" && (
                              <span className="text-[9px] text-red-400 flex items-center gap-0.5" data-testid={`draft-status-failed-${i}`}>
                                <XCircle className="w-2.5 h-2.5" /> Failed
                              </span>
                            )}
                            {status === "no_email" && (
                              <span className="text-[9px] text-orange-400 flex items-center gap-0.5" data-testid={`draft-status-no-email-${i}`}>
                                <AlertCircle className="w-2.5 h-2.5" /> No email
                              </span>
                            )}
                            {status === "sending" && (
                              <span className="text-[9px] text-blue-400 flex items-center gap-0.5" data-testid={`draft-status-sending-${i}`}>
                                <Loader2 className="w-2.5 h-2.5 animate-spin" /> Sending
                              </span>
                            )}
                          </div>
                        </div>
                        <p className="text-[10px] text-white/50 mb-1"><span className="text-white/30">Subject:</span> {draft.subject}</p>
                        <Textarea
                          value={draft.body}
                          onChange={e => setEmailDrafts(prev => {
                            const next = [...prev];
                            next[i] = { ...next[i], body: e.target.value };
                            return next;
                          })}
                          disabled={sendOverallStatus !== "idle"}
                          className="text-[11px] text-white/70 bg-white/5 border-white/10 resize-none min-h-[100px] disabled:opacity-60"
                          data-testid={`email-draft-${i}`}
                        />
                      </div>
                    );
                  })}
                </div>

                {/* Send / Log actions inside the drafts block */}
                {sendOverallStatus === "idle" && (
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      onClick={handleSendOutreach}
                      disabled={sendOutreachMutation.isPending}
                      className="flex-1 h-8 text-xs bg-blue-600 hover:bg-blue-500 text-white font-semibold"
                      data-testid="btn-send-emails"
                    >
                      {sendOutreachMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Send className="w-3 h-3 mr-1" />}
                      Send Emails ({emailDrafts.length})
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleLogOutreach}
                      disabled={outreachLogMutation.isPending}
                      className="flex-1 h-8 text-xs border-white/20 text-white/60 hover:bg-white/5"
                      data-testid="btn-log-without-sending"
                    >
                      {outreachLogMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <ClipboardCheck className="w-3 h-3 mr-1" />}
                      Log Only
                    </Button>
                  </div>
                )}
                {sendOverallStatus === "done" && (
                  <p className="mt-2 text-[10px] text-emerald-400/70 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    Emails sent and logged to lane history. View the History tab for details.
                  </p>
                )}
              </div>
            )}
          </TabsContent>

          {/* ── Import Tab ──────────────────────────────────────────────── */}
          <TabsContent value="import" className="flex-1 px-5 pt-4 pb-20 overflow-y-auto" data-testid="tab-content-import">
            {importResults ? (
              /* Success state — show import results */
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <div>
                    <p className="text-xs font-semibold text-emerald-300">
                      {importResults.filter(r => r.status === "new").length} new carriers imported
                    </p>
                    {importResults.filter(r => r.status === "matched").length > 0 && (
                      <p className="text-[10px] text-white/50">
                        {importResults.filter(r => r.status === "matched").length} matched existing catalog records
                      </p>
                    )}
                    <p className="text-[10px] text-white/50">All carriers added to lane bench</p>
                  </div>
                </div>

                {/* Result list */}
                <div className="flex flex-col gap-1.5">
                  {importResults.map((r, idx) => (
                    <div key={idx} className="flex items-center gap-2 p-2 bg-white/3 rounded border border-white/8">
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${r.status === "new" ? "bg-emerald-400" : "bg-amber-400"}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-white truncate">{r.carrier.name}</p>
                        {r.carrier.primaryEmail && (
                          <p className="text-[10px] text-white/40 truncate">{r.carrier.primaryEmail}</p>
                        )}
                      </div>
                      <Badge variant="outline" className={`text-[9px] py-0 px-1 shrink-0 ${
                        r.status === "new" ? "border-emerald-500/40 text-emerald-400" : "border-amber-500/40 text-amber-400"
                      }`}>
                        {r.status === "new" ? "New" : r.matchType === "email_exact" ? "Email match" : r.matchType === "mc_exact" ? "MC match" : "Name match"}
                      </Badge>
                    </div>
                  ))}
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setImportResults(null);
                    setParsedImportCarriers(null);
                    setImportPasteText("");
                  }}
                  className="w-full text-xs border-white/15 text-white/60 hover:bg-white/6"
                  data-testid="btn-import-again"
                >
                  <Upload className="w-3 h-3 mr-1" />
                  Import More Carriers
                </Button>
              </div>
            ) : parsedImportCarriers ? (
              /* Preview state — show parsed carriers before confirm */
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-white">{parsedImportCarriers.length} carriers parsed</p>
                  <button
                    onClick={() => setParsedImportCarriers(null)}
                    className="text-[10px] text-white/40 hover:text-white/60"
                    data-testid="btn-import-back"
                  >
                    ← Edit
                  </button>
                </div>

                {/* Preview table */}
                <div className="flex flex-col gap-1">
                  <div className="grid grid-cols-12 gap-2 px-2 py-1 text-[9px] uppercase tracking-wide text-white/30">
                    <span className="col-span-5">Name</span>
                    <span className="col-span-4">Email</span>
                    <span className="col-span-3">MC#</span>
                  </div>
                  {parsedImportCarriers.map((c, idx) => (
                    <div key={idx} className="grid grid-cols-12 gap-2 px-2 py-1.5 bg-white/3 rounded border border-white/8">
                      <span className="col-span-5 text-[10px] text-white truncate">{c.name}</span>
                      <span className="col-span-4 text-[10px] text-white/50 truncate">{c.email ?? "—"}</span>
                      <span className="col-span-3 text-[10px] text-white/50 truncate">{c.mcDot ?? "—"}</span>
                    </div>
                  ))}
                </div>

                <Button
                  size="sm"
                  onClick={() => importCarriersMutation.mutate({
                    carriers: parsedImportCarriers,
                    source: importSource,
                    rawInput: importPasteText,
                  })}
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
              /* Input state — paste textarea */
              <div className="flex flex-col gap-4">
                <div>
                  <p className="text-xs text-white/60 mb-3">
                    Paste carrier contacts from DAT, Loadsmart, or any other platform. Supports tab-delimited, CSV, or plain name + email format.
                  </p>
                  <div className="text-[9px] text-white/30 mb-2 font-mono bg-white/3 border border-white/8 rounded px-2 py-1.5 space-y-0.5">
                    <div className="text-white/50 mb-1">Supported formats (one per line):</div>
                    <div>ABC Transport Inc, abc@transport.com, MC123456</div>
                    <div>XYZ Logistics | xyz@logistics.com</div>
                    <div>Smith Trucking LLC {"  "} MC789012</div>
                    <div>John's Hauling Co (paste name only if no email)</div>
                  </div>
                </div>

                {/* Source selector */}
                <div>
                  <p className="text-[9px] text-white/40 uppercase tracking-wide mb-1.5">Source Platform</p>
                  <Select value={importSource} onValueChange={setImportSource}>
                    <SelectTrigger className="h-8 text-xs bg-white/5 border-white/15 text-white/80" data-testid="select-import-source">
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

                {/* Paste area */}
                <div>
                  <p className="text-[9px] text-white/40 uppercase tracking-wide mb-1.5">Carrier List</p>
                  <Textarea
                    value={importPasteText}
                    onChange={e => setImportPasteText(e.target.value)}
                    placeholder={"ABC Transport Inc, abc@transport.com, MC123456\nXYZ Logistics, xyz@example.com\nSmith Trucking LLC"}
                    className="text-[11px] text-white/70 bg-white/5 border-white/10 resize-none min-h-[160px] placeholder:text-white/20 font-mono"
                    data-testid="textarea-import-paste"
                  />
                  {importPasteText && (
                    <p className="text-[9px] text-white/30 mt-1">
                      {importPasteText.split("\n").filter(l => l.trim().length > 2).length} lines detected
                    </p>
                  )}
                </div>

                <Button
                  size="sm"
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
                  <ExternalLink className="w-3 h-3 mr-1" />
                  Parse & Preview
                </Button>
              </div>
            )}
          </TabsContent>

          {/* ── Bench Tab ───────────────────────────────────────────────── */}
          <TabsContent value="bench" className="flex-1 px-5 pt-4 pb-20 overflow-y-auto">
            {bench.length === 0 ? (
              <p className="text-xs text-white/40 py-4">
                No carriers tracked yet. Select carriers from the Suggestions tab and mark them as contacted.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {/* Historical carrier callout */}
                {(() => {
                  const historicalMissingContact = bench.filter(b => b.sourceType === "historical" && !b.isContactable);
                  if (historicalMissingContact.length === 0) return null;
                  return (
                    <div className="bg-blue-500/8 border border-blue-500/20 rounded-lg p-3 flex items-start gap-2 mb-1"
                      data-testid="historical-carriers-callout">
                      <Truck className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-[11px] font-semibold text-blue-300">
                          {historicalMissingContact.length} historical carrier{historicalMissingContact.length > 1 ? "s" : ""} missing contact info
                        </p>
                        <p className="text-[10px] text-blue-300/60 mt-0.5">
                          These carriers have hauled this lane before. Add their phone or email in the Carrier catalog to enable outreach.
                        </p>
                        <p className="text-[10px] text-white/40 mt-1">{historicalMissingContact.map(b => b.carrierName).join(", ")}</p>
                      </div>
                    </div>
                  );
                })()}

                {bench.map(interest => {
                  const statusConfig = INTEREST_STATUS_LABELS[interest.interestStatus] ?? INTEREST_STATUS_LABELS.needs_follow_up;
                  const isExpanded = expandedReply === interest.id;
                  return (
                    <div
                      key={interest.id}
                      className="bg-white/4 rounded-lg border border-white/8 p-3"
                      data-testid={`bench-item-${interest.id}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                          <p className="text-xs font-semibold text-white truncate">{interest.carrierName}</p>
                          {interest.sourceType === "historical" && (
                            <Badge variant="outline" className="text-[9px] py-0 px-1 border-blue-500/30 text-blue-400">
                              Ran this lane
                            </Badge>
                          )}
                          {!interest.isContactable && (
                            <Badge variant="outline" className="text-[9px] py-0 px-1 border-orange-500/30 text-orange-400 flex items-center gap-0.5">
                              <Mail className="w-2.5 h-2.5" />
                              No contact info
                            </Badge>
                          )}
                          </div>
                          {interest.outreachSentAt && (
                            <p className="text-[10px] text-white/30 mt-0.5">
                              Contacted {new Date(interest.outreachSentAt).toLocaleDateString()}
                            </p>
                          )}
                          {interest.lastReplySnippet && (
                            <p className="text-[10px] text-white/50 italic mt-0.5 line-clamp-2">
                              "{interest.lastReplySnippet}"
                            </p>
                          )}
                        </div>
                        <Badge variant="outline" className={`text-[9px] py-0 px-1.5 shrink-0 ${statusConfig.color}`}>
                          {statusConfig.label}
                        </Badge>
                      </div>

                      {/* Manual interest status override */}
                      <div className="mt-2 flex flex-wrap gap-1">
                        {([
                          { value: "available_now", label: "Avail. Now" },
                          { value: "available_next_week", label: "Next Wk" },
                          { value: "future_interest", label: "Future" },
                          { value: "not_fit", label: "Not a Fit" },
                        ] as const).map(opt => (
                          <button
                            key={opt.value}
                            onClick={() => setInterestStatusMutation.mutate({
                              carrierId: interest.carrierId ?? null,
                              carrierName: interest.carrierName,
                              interestStatus: opt.value,
                            })}
                            disabled={setInterestStatusMutation.isPending}
                            className={`text-[9px] px-1.5 py-0.5 rounded border transition-colors ${
                              interest.interestStatus === opt.value
                                ? "border-blue-400/60 bg-blue-500/20 text-blue-300"
                                : "border-white/10 bg-white/5 text-white/30 hover:text-white/60 hover:border-white/20"
                            }`}
                            data-testid={`status-${opt.value}-${interest.id}`}
                          >
                            {opt.value === interest.interestStatus ? "✓ " : ""}{opt.label}
                          </button>
                        ))}
                      </div>

                      {/* Reply classify toggle */}
                      <button
                        onClick={() => setExpandedReply(isExpanded ? null : interest.id)}
                        className="mt-2 flex items-center gap-1 text-[10px] text-white/30 hover:text-white/60"
                        data-testid={`classify-toggle-${interest.id}`}
                      >
                        <Mail className="w-3 h-3" />
                        Classify reply
                        {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      </button>

                      {isExpanded && (
                        <div className="mt-2 flex flex-col gap-2">
                          <Textarea
                            placeholder="Paste carrier reply here…"
                            value={replyInputs[interest.id] ?? ""}
                            onChange={e => setReplyInputs(prev => ({ ...prev, [interest.id]: e.target.value }))}
                            className="text-[11px] text-white/70 bg-white/5 border-white/10 resize-none min-h-[60px]"
                            data-testid={`reply-input-${interest.id}`}
                          />
                          <Button
                            size="sm"
                            onClick={() => handleClassifyReply(interest)}
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
          </TabsContent>

          {/* ── Follow-up Tab ────────────────────────────────────────────── */}
          <TabsContent value="followup" className="flex-1 px-5 pt-4 pb-20 overflow-y-auto">
            {followupLoading ? (
              <div className="flex items-center gap-2 text-white/40 text-xs py-4">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading suggestions…
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {(followupData?.suggestions ?? []).length === 0 && (
                  <p className="text-xs text-white/40 py-4">
                    No follow-up suggestions yet — contact some carriers first.
                  </p>
                )}
                {(followupData?.suggestions ?? []).map((s, i) => (
                  <div
                    key={i}
                    className={`p-3 rounded-lg border flex items-start gap-2 ${
                      s.priority === "high" ? "bg-amber-500/8 border-amber-500/20" :
                      s.priority === "medium" ? "bg-white/4 border-white/10" :
                      "bg-white/2 border-white/6"
                    }`}
                    data-testid={`followup-suggestion-${i}`}
                  >
                    <Lightbulb className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
                      s.priority === "high" ? "text-amber-400" :
                      s.priority === "medium" ? "text-white/50" : "text-white/30"
                    }`} />
                    <p className="text-xs text-white/70">{s.message}</p>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* ── History Tab ──────────────────────────────────────────────── */}
          <TabsContent value="history" className="flex-1 px-5 pt-4 pb-20 overflow-y-auto">
            {outreachHistory.length === 0 ? (
              <p className="text-xs text-white/40 py-4">
                No outreach history yet. Send emails to see them logged here.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {outreachHistory.map(log => {
                  const status = log.deliveryStatus ?? "draft";
                  const statusConfig = {
                    sent: { label: "Sent", color: "text-emerald-400", icon: <CheckCircle2 className="w-3 h-3" /> },
                    partial: { label: "Partial", color: "text-amber-400", icon: <AlertCircle className="w-3 h-3" /> },
                    failed: { label: "Failed", color: "text-red-400", icon: <XCircle className="w-3 h-3" /> },
                    draft: { label: "Logged", color: "text-white/40", icon: <ClipboardCheck className="w-3 h-3" /> },
                  }[status] ?? { label: status, color: "text-white/40", icon: <Clock className="w-3 h-3" /> };
                  return (
                    <div key={log.id} className="bg-white/4 rounded-lg border border-white/8 p-3" data-testid={`outreach-log-${log.id}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`flex items-center gap-1 text-[10px] font-semibold ${statusConfig.color}`}>
                              {statusConfig.icon}
                              {statusConfig.label}
                            </span>
                            <span className="text-[9px] text-white/30">·</span>
                            <span className="text-[9px] text-white/40">
                              {log.outreachMode === "immediate_plus_lane" ? "Immediate + Lane" : "Lane-Building"}
                            </span>
                          </div>
                          <p className="text-[10px] text-white/70 mt-1 font-medium">
                            {log.carrierNames.join(", ")}
                          </p>
                          {log.sentAt && (
                            <p className="text-[9px] text-white/30 mt-0.5">
                              Sent {new Date(log.sentAt).toLocaleString()}
                            </p>
                          )}
                          {!log.sentAt && (
                            <p className="text-[9px] text-white/30 mt-0.5">
                              Logged {new Date(log.timestamp).toLocaleString()}
                            </p>
                          )}
                          {log.failureReason && (
                            <p className="text-[9px] text-red-400/70 mt-0.5">Error: {log.failureReason}</p>
                          )}
                        </div>
                        <span className="text-[9px] text-white/30 shrink-0">
                          {log.carrierNames.length} carrier{log.carrierNames.length !== 1 ? "s" : ""}
                        </span>
                      </div>

                      {/* Per-recipient breakdown */}
                      {log.recipients && log.recipients.length > 0 && (
                        <div className="mt-2 flex flex-col gap-1">
                          {log.recipients.map((r, ri) => (
                            <div key={ri} className="flex items-center gap-2 text-[9px]">
                              <span className="text-white/50">{r.carrierName}</span>
                              {r.email && <span className="text-white/30">{r.email}</span>}
                              {r.status === "sent" && <span className="text-emerald-400 flex items-center gap-0.5"><CheckCircle2 className="w-2 h-2" /> sent</span>}
                              {r.status === "failed" && <span className="text-red-400 flex items-center gap-0.5"><XCircle className="w-2 h-2" /> {r.error ?? "failed"}</span>}
                              {r.status === "no_email" && <span className="text-orange-400">no email on file</span>}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Show drafted email subjects */}
                      {log.emailDrafts && log.emailDrafts.length > 0 && (
                        <div className="mt-2 flex flex-col gap-0.5">
                          {log.emailDrafts.map((d, di) => (
                            <p key={di} className="text-[9px] text-white/30 truncate">
                              <span className="text-white/20">Subject:</span> {d.subject}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>

        {/* Sticky action bar */}
        <div className="fixed bottom-0 right-0 w-full sm:max-w-xl bg-slate-900/95 backdrop-blur border-t border-white/8 px-5 py-3 flex gap-2 z-50">
          <Button
            variant="outline"
            size="sm"
            onClick={handleGenerateOutreach}
            disabled={selectedCarriers.size === 0 || draftEmailsMutation.isPending}
            className="flex-1 h-8 text-xs border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
            data-testid="btn-generate-outreach"
          >
            {draftEmailsMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Mail className="w-3 h-3 mr-1" />}
            Generate Carrier Outreach ({selectedCarriers.size})
          </Button>
          <Button
            size="sm"
            onClick={showEmails && emailDrafts.length > 0 ? handleSendOutreach : handleLogOutreach}
            disabled={(selectedCarriers.size === 0 && emailDrafts.length === 0) || outreachLogMutation.isPending || sendOutreachMutation.isPending}
            className="flex-1 h-8 text-xs bg-amber-500 hover:bg-amber-400 text-black font-semibold"
            data-testid="btn-mark-contacted"
          >
            {(outreachLogMutation.isPending || sendOutreachMutation.isPending) ? (
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
            ) : showEmails && emailDrafts.length > 0 ? (
              <Send className="w-3 h-3 mr-1" />
            ) : (
              <CheckCircle2 className="w-3 h-3 mr-1" />
            )}
            {showEmails && emailDrafts.length > 0 ? `Send Emails (${emailDrafts.length})` : `Mark Contacted (${selectedCarriers.size})`}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
