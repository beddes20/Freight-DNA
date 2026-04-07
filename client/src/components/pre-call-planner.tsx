import { useRef, useState, useEffect, useMemo, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Phone,
  Mail,
  MessageSquare,
  MapPin,
  Printer,
  User,
  Clock,
  ClipboardList,
  AlertTriangle,
  TrendingUp,
  Trophy,
  Activity,
  DollarSign,
  Building2,
  Sparkles,
  Loader2,
  Brain,
  Send,
  Zap,
  ChevronDown,
  ChevronUp,
  CheckSquare,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useQuery, useMutation } from "@tanstack/react-query";
import { fmtMoney } from "@/lib/rep-utils";
import type { Company, Contact, Touchpoint, Rfp, Award } from "@shared/schema";
import { ContactIntelModal } from "@/components/contact-intel-modal";
import { OutlookComposeDialog } from "@/components/outlook-compose-dialog";
import { GrowthScoreBadge } from "@/components/account-growth-portlet";
import { invalidateAfterTouchpoint } from "@/lib/invalidations";
import { buildAiToasts } from "@/lib/aiTouchUtils";
import { useToast } from "@/hooks/use-toast";

// ── Types ─────────────────────────────────────────────────────────────────────

type TaskLike = { id: string | number; title: string; status: string; dueDate?: string | null };
type FinancialSummary = { totalLoads: number; totalMargin: number; totalRevenue?: number } | null;

interface HealthFactor { name: string; score: number; max: number; label: string }
interface HealthScore { score: number; grade: string; color: string; momentum?: "up" | "flat" | "down"; momentumLabel?: string; factors: HealthFactor[] }

interface PreCallPlannerProps {
  open: boolean;
  onClose: () => void;
  company: Company;
  contacts: Contact[];
  touchpoints: Touchpoint[];
  tasks: TaskLike[];
  rfps: Rfp[];
  awards: Award[];
  financialSummary: FinancialSummary;
  healthScore: HealthScore | null | undefined;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const touchTypeIcon = (type: string) => {
  if (type === "call")       return <Phone className="h-3.5 w-3.5 text-blue-500" />;
  if (type === "email")      return <Mail className="h-3.5 w-3.5 text-purple-500" />;
  if (type === "text")       return <MessageSquare className="h-3.5 w-3.5 text-green-500" />;
  if (type === "site_visit") return <MapPin className="h-3.5 w-3.5 text-orange-500" />;
  return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
};

const healthBadgeColor = (color: string) => {
  if (color === "green") return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
  if (color === "blue")  return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
  if (color === "amber") return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
  return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
};

const BASE_BADGE: Record<string, string> = {
  hr:    "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
  "3rd": "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400",
  "2nd": "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400",
  "1st": "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
};
const BASE_LABEL: Record<string, string> = {
  hr: "Home Run", "3rd": "3rd Base", "2nd": "2nd Base", "1st": "1st Base",
};
const BASE_PRIORITY: Record<string, number> = { hr: 0, "3rd": 1, "2nd": 2, "1st": 3 };

const normalizeBase = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v.startsWith("hr") || v.includes("home")) return "hr";
  if (v.startsWith("3")) return "3rd";
  if (v.startsWith("2")) return "2nd";
  if (v.startsWith("1")) return "1st";
  return null;
};

const contactBasePriority = (raw: string | null | undefined) =>
  BASE_PRIORITY[normalizeBase(raw) ?? ""] ?? 4;

// ── CollapsibleSection ────────────────────────────────────────────────────────

function CollapsibleSection({
  title,
  icon,
  defaultOpen = false,
  children,
  testId,
}: {
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <button
        type="button"
        className="w-full flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1 mb-2 hover:text-foreground transition-colors"
        onClick={() => setOpen(o => !o)}
        data-testid={testId}
      >
        <span className="flex items-center gap-1.5">{icon}{title}</span>
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      {open && children}
    </section>
  );
}

// ── NBA Inline Strip ──────────────────────────────────────────────────────────

const NBA_URGENCY_CFG: Record<string, { border: string; badge: string; icon: string }> = {
  critical: { border: "border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/20",     badge: "text-red-700 bg-red-100 dark:bg-red-900/40 dark:text-red-300",     icon: "text-red-500"           },
  high:     { border: "border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/20", badge: "text-amber-700 bg-amber-100 dark:bg-amber-900/40 dark:text-amber-300", icon: "text-amber-500"     },
  medium:   { border: "border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/20",   badge: "text-blue-700 bg-blue-100 dark:bg-blue-900/40 dark:text-blue-300",   icon: "text-blue-500"        },
  low:      { border: "border-border bg-muted/30",                                             badge: "text-muted-foreground bg-muted",                                    icon: "text-muted-foreground" },
  none:     { border: "border-border bg-muted/20",                                             badge: "text-muted-foreground bg-muted",                                    icon: "text-muted-foreground" },
};

function NbaStrip({
  companyId,
  onLogTouch,
  onComposeEmail,
  onCreateTask,
}: {
  companyId: string;
  onLogTouch: () => void;
  onComposeEmail: () => void;
  onCreateTask: () => void;
}) {
  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/companies", companyId, "next-best-action"],
    staleTime: 15 * 60 * 1000,
  });
  if (isLoading) return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading recommendation…
    </div>
  );
  if (!data || data.urgency === "none") return null;
  const cfg = NBA_URGENCY_CFG[data.urgency] ?? NBA_URGENCY_CFG.low;
  const handleCta = () => {
    if (data.cta === "log_touch")       { onLogTouch();     return; }
    if (data.cta === "compose_email")   { onComposeEmail(); return; }
    if (data.cta === "create_task" || data.cta === "schedule_meeting") { onCreateTask(); return; }
    // "none" or unknown CTA — no-op
  };
  return (
    <div className={`flex items-start gap-3 rounded-lg border px-3 py-2 ${cfg.border}`} data-testid="precall-nba-strip">
      <Zap className={`h-4 w-4 mt-0.5 shrink-0 ${cfg.icon}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold">{data.actionName}</span>
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full capitalize ${cfg.badge}`}>{data.urgency}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{data.reason}</p>
      </div>
      {data.cta !== "none" && (
        <Button size="sm" variant="ghost" className="h-7 text-xs shrink-0 px-2" onClick={handleCta} data-testid="button-nba-cta-strip">
          {data.ctaLabel}
        </Button>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function PreCallPlanner({
  open,
  onClose,
  company,
  contacts,
  touchpoints,
  tasks,
  rfps,
  awards,
  financialSummary,
  healthScore,
}: PreCallPlannerProps) {
  const printRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  // AI state
  const [talkingPoints, setTalkingPoints] = useState<string[]>([]);
  const [loadingPoints, setLoadingPoints] = useState(false);
  const [selectedContactForIntel, setSelectedContactForIntel] = useState<Contact | null>(null);
  const [composeTarget, setComposeTarget] = useState<Contact | null>(null);
  const [narrativeEnabled, setNarrativeEnabled] = useState(false);

  // Footer — log touch
  const [logOpen, setLogOpen] = useState(false);
  const [logType, setLogType] = useState("call");
  const [logContactId, setLogContactId] = useState("");
  const [logNote, setLogNote] = useState("");
  const [logSentiment, setLogSentiment] = useState("");
  const [logMeaningful, setLogMeaningful] = useState(false);

  // Footer — create task
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDue, setTaskDue] = useState("");

  useEffect(() => {
    if (open) setNarrativeEnabled(true);
  }, [open]);

  // ── Precomputed touchpoint map (O(n) build, avoids repeated filter+sort per contact) ──

  const lastTouchByContactId = useMemo<Map<string, Touchpoint>>(() => {
    const map = new Map<string, Touchpoint>();
    for (const tp of touchpoints) {
      const existing = map.get(tp.contactId);
      if (!existing || tp.date > existing.date) map.set(tp.contactId, tp);
    }
    return map;
  }, [touchpoints]);

  // ── Data fetches ─────────────────────────────────────────────────────────────

  const touchpointsWithNotes = useMemo(() => touchpoints.filter(t => t.notes?.trim()), [touchpoints]);

  const { data: relFreightData } = useQuery<{ contacts: any[]; companyId: string }>({
    queryKey: ["/api/companies", company.id, "relationship-freight-summary"],
    queryFn: () => fetch(`/api/companies/${company.id}/relationship-freight-summary`, { credentials: "include" }).then(r => r.json()),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  const { data: tpSummaryData, isLoading: tpSummaryLoading } = useQuery<{ summary: string | null; noteCount: number }>({
    queryKey: ["/api/companies", company.id, "touchpoint-summary"],
    queryFn: () => fetch(`/api/companies/${company.id}/touchpoint-summary`, { credentials: "include" }).then(r => r.json()),
    enabled: open && touchpointsWithNotes.length > 0,
    staleTime: 10 * 60 * 1000,
  });

  const { data: healthNarrativeData, isLoading: narrativeLoading } = useQuery<{ narrative: string }>({
    queryKey: ["/api/companies", company.id, "health-narrative"],
    queryFn: () => apiRequest("POST", `/api/companies/${company.id}/health-narrative`, {
      score: healthScore!.score,
      grade: healthScore!.grade,
      factors: healthScore!.factors,
      momentum: healthScore!.momentum,
      momentumLabel: healthScore!.momentumLabel,
    }).then(r => r.json()),
    enabled: narrativeEnabled && !!healthScore && open,
    staleTime: 15 * 60 * 1000,
  });

  const { data: growthScore } = useQuery<any>({
    queryKey: ["/api/companies", company.id, "growth-score"],
    enabled: open,
    staleTime: 15 * 60 * 1000,
  });

  // ── Mutations ─────────────────────────────────────────────────────────────────

  const logTouchMutation = useMutation({
    mutationFn: ({ contactId, type, notes, sentiment, isMeaningful }: {
      contactId: string; type: string; notes: string; sentiment?: string; isMeaningful?: boolean;
    }) =>
      apiRequest("POST", `/api/contacts/${contactId}/touchpoints`, {
        type,
        date: new Date().toISOString().slice(0, 10),
        notes,
        sentiment: sentiment || null,
        isMeaningful: isMeaningful || false,
      }).then(r => r.json()),
    onSuccess: (data: any) => {
      invalidateAfterTouchpoint(company.id);
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      toast({ title: "Touch logged!" });
      buildAiToasts(data?.aiInsights, data?.autoTask, toast);
      setLogOpen(false);
      setLogNote("");
      setLogSentiment("");
      setLogMeaningful(false);
    },
    onError: () => toast({ title: "Failed to log touch", variant: "destructive" }),
  });

  const createTaskMutation = useMutation({
    mutationFn: ({ title, dueDate }: { title: string; dueDate: string }) =>
      apiRequest("POST", "/api/tasks", {
        title,
        dueDate: dueDate || null,
        companyId: company.id,
        status: "open",
      }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      toast({ title: "Task created!" });
      setTaskOpen(false);
      setTaskTitle("");
      setTaskDue("");
    },
    onError: () => toast({ title: "Failed to create task", variant: "destructive" }),
  });

  // ── Derived data ──────────────────────────────────────────────────────────────

  const companyRfps   = useMemo(() => rfps.filter(r => r.companyId === company.id), [rfps, company.id]);
  const companyAwards = useMemo(() => awards.filter(a => a.companyId === company.id), [awards, company.id]);
  const activeRfps    = useMemo(() => companyRfps.filter(r => r.status === "open" || r.status === "pending"), [companyRfps]);
  const inactiveRfps  = useMemo(() => companyRfps.filter(r => r.status !== "open" && r.status !== "pending"), [companyRfps]);
  const openTasks     = useMemo(() => tasks.filter(t => t.status !== "complete" && t.status !== "completed"), [tasks]);

  const urgentRfps = useMemo(() => activeRfps.filter(r => {
    if (!r.dueDate) return false;
    const days = Math.ceil((new Date(r.dueDate).getTime() - Date.now()) / 86400000);
    return days >= 0 && days <= 14;
  }), [activeRfps]);

  // Sorted contacts: uses lastTouchByContactId map — no per-pair filter/sort
  const sortedContacts = useMemo(() => [...contacts].sort((a, b) => {
    const pa = contactBasePriority((a as any).relationshipBase);
    const pb = contactBasePriority((b as any).relationshipBase);
    if (pa !== pb) return pa - pb;
    const la = lastTouchByContactId.get(a.id)?.date ?? "";
    const lb = lastTouchByContactId.get(b.id)?.date ?? "";
    return lb.localeCompare(la);
  }), [contacts, lastTouchByContactId]);

  const lastMeaningful = useMemo(() =>
    touchpoints
      .filter(t => (t as any).isMeaningful)
      .sort((a, b) => b.date.localeCompare(a.date))[0] ?? null,
  [touchpoints]);

  const last3Touchpoints = useMemo(() =>
    [...touchpoints].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3),
  [touchpoints]);

  const hasAccountIntel = !!(
    company.accountQuirks || company.spotProcess ||
    company.tenderStyle  || company.dlEmail      || company.processNotes
  );

  // ── Best contact preselection for footer actions ──────────────────────────────
  // Priority: 1) highest relationship base  2) most recently touched  3) first in list
  const pickBestContact = useCallback((): string => {
    if (contacts.length === 0) return "";
    const withBase = contacts.filter(c => normalizeBase((c as any).relationshipBase) !== null);
    if (withBase.length > 0) {
      return withBase.reduce((best, c) =>
        contactBasePriority((c as any).relationshipBase) < contactBasePriority((best as any).relationshipBase) ? c : best
      ).id;
    }
    const mostRecent = contacts.reduce((best, c) => {
      const la = lastTouchByContactId.get(best.id)?.date ?? "";
      const lb = lastTouchByContactId.get(c.id)?.date ?? "";
      return lb > la ? c : best;
    });
    return mostRecent.id;
  }, [contacts, lastTouchByContactId]);

  // ── Handlers ──────────────────────────────────────────────────────────────────

  const generateTalkingPoints = async () => {
    setLoadingPoints(true);
    try {
      const res = await apiRequest("POST", "/api/ai/talking-points", {
        company, contacts, touchpoints, tasks, rfps,
        financialSummary: financialSummary
          ? { ytdLoads: financialSummary.totalLoads, ytdMargin: financialSummary.totalMargin }
          : null,
        accountIntelligence: {
          quirks: (company as any).accountQuirks,
          spotProcess: (company as any).spotProcess,
        },
      });
      const data = await res.json();
      setTalkingPoints(data.points || []);
    } catch {
      setTalkingPoints(["Unable to generate talking points. Try again."]);
    } finally {
      setLoadingPoints(false);
    }
  };

  const handlePrint = () => {
    const win = window.open("", "_blank");
    if (!win || !printRef.current) return;
    win.document.write(`
      <html><head><title>Pre-Call Brief — ${company.name}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111; padding: 24px; max-width: 800px; margin: 0 auto; font-size: 13px; }
        h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
        h2 { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; margin: 16px 0 8px; }
        .meta { color: #6b7280; font-size: 12px; }
        .contact-card { border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px 12px; margin-bottom: 6px; }
        .contact-name { font-weight: 600; }
        .contact-title { color: #6b7280; font-size: 12px; }
        td, th { text-align: left; padding: 4px 8px; font-size: 12px; border-bottom: 1px solid #f3f4f6; }
        th { font-weight: 600; color: #6b7280; }
        .alert { background: #fef3c7; border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; font-size: 12px; }
        .label { font-weight: 600; min-width: 120px; color: #374151; }
        .row { display: flex; gap: 16px; margin-bottom: 6px; }
      </style>
      </head><body>
      ${printRef.current.innerHTML}
      <p class="meta" style="margin-top:24px;color:#9ca3af;">Generated ${new Date().toLocaleString()}</p>
      </body></html>
    `);
    win.document.close();
    win.print();
  };

  const openLogTouch = useCallback((type: string) => {
    setLogType(type);
    setLogContactId(pickBestContact());
    setLogOpen(true);
  }, [pickBestContact]);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
        <DialogContent className="max-w-2xl flex flex-col max-h-[90vh] p-0 gap-0">

          {/* Header */}
          <DialogHeader className="px-5 pt-4 pb-3 shrink-0 border-b">
            <DialogTitle className="flex items-center gap-2 text-base">
              <ClipboardList className="h-4 w-4 text-primary" />
              Pre-Call Brief — {company.name}
            </DialogTitle>
          </DialogHeader>

          {/* Scrollable body */}
          <div ref={printRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

            {/* ── ZONE 1: Header / Current State ─────────────────────────── */}
            <section className="space-y-3">
              <div className="flex items-start gap-3">
                <div className="h-9 w-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                  <Building2 className="h-5 w-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-base font-semibold" data-testid="precall-company-name">{company.name}</h2>
                    {healthScore && (
                      <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${healthBadgeColor(healthScore.color)}`}>
                        <Activity className="h-3 w-3" />
                        {healthScore.grade} · {healthScore.score}/100
                        {healthScore.momentum && (
                          <span className={healthScore.momentum === "up" ? "text-green-600" : healthScore.momentum === "down" ? "text-red-500" : ""}>
                            {healthScore.momentum === "up" ? " ↑" : healthScore.momentum === "down" ? " ↓" : " →"}
                          </span>
                        )}
                      </span>
                    )}
                    {growthScore && (
                      <GrowthScoreBadge
                        score={growthScore.score}
                        band={growthScore.band}
                        bandLabel={growthScore.bandLabel}
                      />
                    )}
                  </div>

                  {/* Inline financials + shipping modes */}
                  <div className="flex items-center gap-3 mt-1 flex-wrap">
                    {financialSummary && (
                      <span className="text-sm text-muted-foreground flex items-center gap-1">
                        <DollarSign className="h-3.5 w-3.5" />
                        YTD: <strong className="text-foreground">{financialSummary.totalLoads.toLocaleString()}</strong> loads
                        &nbsp;·&nbsp;
                        <strong className="text-foreground">{fmtMoney(financialSummary.totalMargin)}</strong> margin
                      </span>
                    )}
                    {((company as any).shippingModes?.length > 0) && (
                      <div className="flex items-center gap-1 flex-wrap">
                        {((company as any).shippingModes as string[]).map((m: string) => (
                          <span key={m} className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/30">{m}</span>
                        ))}
                      </div>
                    )}
                  </div>

                  {(company.industry || company.website) && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                      {company.industry && <span>{company.industry}</span>}
                      {company.website && (
                        <a
                          href={company.website.startsWith("http") ? company.website : `https://${company.website}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-500 hover:underline"
                        >{company.website}</a>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* RFP Urgency Banner */}
              {urgentRfps.length > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/20 px-3 py-2" data-testid="precall-rfp-urgency-banner">
                  <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <span className="font-semibold text-amber-800 dark:text-amber-300">
                      {urgentRfps.length === 1 ? "Active RFP due soon:" : `${urgentRfps.length} RFPs due soon:`}
                    </span>
                    <span className="text-amber-700 dark:text-amber-400 ml-1">
                      {urgentRfps.map(r => `${r.title}${r.dueDate ? ` (${r.dueDate})` : ""}`).join(", ")}
                    </span>
                  </div>
                </div>
              )}

              {/* NBA Strip */}
              <NbaStrip
                companyId={company.id}
                onLogTouch={() => openLogTouch("call")}
                onComposeEmail={() => {
                  // Open Outlook compose toward the best contact available
                  const best = sortedContacts.find(c => c.email) ?? null;
                  setComposeTarget(best);
                }}
                onCreateTask={() => setTaskOpen(true)}
              />
            </section>

            {/* ── ZONE 2: Account Quirks & Process ───────────────────────── */}
            {hasAccountIntel && (
              <section className="rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50/60 dark:bg-amber-950/10 px-3 py-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400 mb-2 flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" /> Account Quirks & Process
                </h3>
                <div className="space-y-1.5 text-sm">
                  {company.tenderStyle && (
                    <div className="flex gap-2"><span className="font-medium text-xs w-28 shrink-0 text-muted-foreground pt-0.5">Tender Style</span><span>{company.tenderStyle}</span></div>
                  )}
                  {company.spotProcess && (
                    <div className="flex gap-2"><span className="font-medium text-xs w-28 shrink-0 text-muted-foreground pt-0.5">Spot Process</span><span>{company.spotProcess}</span></div>
                  )}
                  {company.dlEmail && (
                    <div className="flex gap-2"><span className="font-medium text-xs w-28 shrink-0 text-muted-foreground pt-0.5">Dispatch Email</span><span>{company.dlEmail}</span></div>
                  )}
                  {company.accountQuirks && (
                    <div className="flex gap-2"><span className="font-medium text-xs w-28 shrink-0 text-muted-foreground pt-0.5">Quirks</span><span>{company.accountQuirks}</span></div>
                  )}
                  {company.processNotes && (
                    <div className="flex gap-2"><span className="font-medium text-xs w-28 shrink-0 text-muted-foreground pt-0.5">Process Notes</span><span>{company.processNotes}</span></div>
                  )}
                </div>
              </section>
            )}

            {/* ── ZONE 3: Key Contacts ────────────────────────────────────── */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1 mb-2 flex items-center gap-1.5">
                <User className="h-3.5 w-3.5" /> Key Contacts
              </h3>
              {sortedContacts.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No contacts on file</p>
              ) : (
                <div className="space-y-2">
                  {sortedContacts.slice(0, 6).map(c => {
                    const lastTp = lastTouchByContactId.get(c.id) ?? null;
                    const relContact = relFreightData?.contacts?.find((rc: any) => rc.id === c.id);
                    const bKey = normalizeBase((c as any).relationshipBase);
                    const hasNoBase = !bKey;

                    return (
                      <div
                        key={c.id}
                        className={`flex flex-col gap-2 rounded-md border px-3 py-2.5 transition-colors cursor-pointer hover:bg-muted/50 hover:border-primary/40 ${hasNoBase ? "opacity-60" : ""}`}
                        data-testid={`precall-contact-${c.id}`}
                        onClick={() => setSelectedContactForIntel(c)}
                      >
                        {/* Contact name + base badge + last touch */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-medium text-sm flex items-center gap-1.5 flex-wrap">
                              {c.name}
                              {bKey ? (
                                <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${BASE_BADGE[bKey]}`}>
                                  {BASE_LABEL[bKey]}
                                </span>
                              ) : (
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-muted text-muted-foreground"
                                  title="No relationship base assigned — visit contact detail to set one"
                                >
                                  No base set
                                </span>
                              )}
                            </div>
                            {c.title && <div className="text-xs text-muted-foreground">{c.title}</div>}
                            {relContact && (relContact.loads > 0 || relContact.laneCount > 0) && (
                              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                                {relContact.laneCount > 0 && <span>{relContact.laneCount} lane{relContact.laneCount !== 1 ? "s" : ""}</span>}
                                {relContact.loads > 0 && <span>{relContact.loads} loads</span>}
                                {relContact.margin > 0 && <span className="text-emerald-600 dark:text-emerald-400">${(relContact.margin / 1000).toFixed(1)}k margin</span>}
                              </div>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground text-right shrink-0">
                            {lastTp && <div className="whitespace-nowrap">Last: {lastTp.date}</div>}
                            <div className="text-primary text-xs mt-0.5">View intel →</div>
                          </div>
                        </div>

                        {/* Always-visible phone + email actions */}
                        {(c.phone || c.email) && (
                          <div className="flex items-center gap-2 flex-wrap" onClick={e => e.stopPropagation()}>
                            {c.phone && (
                              <a
                                href={`tel:${c.phone}`}
                                className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-md bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-950/50 transition-colors border border-green-200 dark:border-green-800/50"
                                data-testid={`precall-phone-${c.id}`}
                              >
                                <Phone className="h-3 w-3" /> {c.phone}
                              </a>
                            )}
                            {c.email && (
                              <button
                                onClick={() => setComposeTarget(c)}
                                className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-md bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-950/50 transition-colors border border-blue-200 dark:border-blue-800/50"
                                data-testid={`precall-email-${c.id}`}
                              >
                                <Send className="h-3 w-3" /> {c.email}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* ── ZONE 4: Conversation Context ────────────────────────────── */}
            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1 flex items-center gap-1.5">
                <MessageSquare className="h-3.5 w-3.5" /> Conversation Context
              </h3>

              {/* Last Meaningful Conversation — inline 1-liner */}
              {lastMeaningful && (() => {
                const contact = contacts.find(c => c.id === lastMeaningful.contactId);
                const daysAgo = Math.floor((Date.now() - new Date(lastMeaningful.date).getTime()) / 86400000);
                return (
                  <div
                    className="flex items-start gap-2 text-sm bg-green-50/60 dark:bg-green-950/20 border border-green-200/60 dark:border-green-800/40 rounded-md px-3 py-2"
                    data-testid="precall-last-meaningful"
                  >
                    <MessageSquare className="h-3.5 w-3.5 text-green-600 mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <span className="font-medium">{contact?.name || "Unknown"}</span>
                      <span className="text-muted-foreground ml-1">· {daysAgo}d ago</span>
                      {lastMeaningful.notes && (
                        <p className="text-xs text-muted-foreground italic mt-0.5 line-clamp-2">"{lastMeaningful.notes}"</p>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* AI Conversation Summary — primary */}
              {touchpointsWithNotes.length > 0 && (
                <div className="bg-indigo-50 dark:bg-indigo-950/20 border border-indigo-200 dark:border-indigo-800/50 rounded-lg p-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300 mb-2 flex items-center gap-1.5">
                    <Brain className="h-3.5 w-3.5" /> AI Conversation Summary
                    {tpSummaryData?.noteCount && (
                      <span className="font-normal normal-case text-indigo-500 dark:text-indigo-400">— last {tpSummaryData.noteCount} notes</span>
                    )}
                  </h4>
                  {tpSummaryLoading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />
                      Summarizing conversation history…
                    </div>
                  ) : tpSummaryData?.summary ? (
                    <div className="space-y-1">
                      {tpSummaryData.summary.split("\n").map((line, i) => {
                        const trimmed = line.replace(/^[-•*]\s*/, "").trim();
                        if (!trimmed) return null;
                        return (
                          <div key={i} className="flex items-start gap-1.5 text-sm">
                            <span className="text-indigo-400 shrink-0 mt-0.5">•</span>
                            <span className="text-foreground/90">{trimmed}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">Unable to summarize — try again later.</p>
                  )}
                </div>
              )}

              {/* Last 3 Touchpoints — collapsed reference */}
              {last3Touchpoints.length > 0 && (
                <CollapsibleSection
                  title={`Last ${last3Touchpoints.length} Touchpoints`}
                  icon={<Clock className="h-3.5 w-3.5" />}
                  defaultOpen={false}
                  testId="toggle-last-touchpoints"
                >
                  <div className="space-y-1.5 mt-2">
                    {last3Touchpoints.map(tp => (
                      <div key={tp.id} className="flex items-start gap-2 text-sm" data-testid={`precall-tp-${tp.id}`}>
                        <span className="shrink-0 pt-0.5">{touchTypeIcon(tp.type)}</span>
                        <span className="text-muted-foreground shrink-0 w-24 text-xs pt-0.5">{tp.date}</span>
                        <span className="capitalize text-xs font-medium shrink-0 w-16 pt-0.5">{tp.type.replace("_", " ")}</span>
                        <span className="text-xs text-muted-foreground line-clamp-2">{tp.notes || <em>No notes</em>}</span>
                      </div>
                    ))}
                  </div>
                </CollapsibleSection>
              )}
            </section>

            {/* ── ZONE 5: Open Tasks ──────────────────────────────────────── */}
            {openTasks.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1 mb-2 flex items-center gap-1.5">
                  <CheckSquare className="h-3.5 w-3.5" /> Open Tasks ({openTasks.length})
                </h3>
                <div className="space-y-1">
                  {openTasks.slice(0, 5).map(t => (
                    <div key={t.id} className="flex items-center justify-between text-sm gap-2" data-testid={`precall-task-${t.id}`}>
                      <span className="line-clamp-1">{t.title}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        {t.dueDate && <span className="text-xs text-muted-foreground">{t.dueDate}</span>}
                        <Badge variant="outline" className="text-xs capitalize">{t.status.replace("_", " ")}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── ZONE 6: Collapsed Reference Sections ───────────────────── */}

            {/* RFP & Awards */}
            {(companyRfps.length > 0 || companyAwards.length > 0) && (
              <CollapsibleSection
                title="RFP & Awards"
                icon={<Trophy className="h-3.5 w-3.5" />}
                defaultOpen={activeRfps.length > 0}
                testId="toggle-rfp-awards"
              >
                <div className="space-y-1 mt-2">
                  {activeRfps.map(r => (
                    <div key={r.id} className="flex items-center justify-between text-sm gap-2">
                      <span className="line-clamp-1">{r.title}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        {r.dueDate && <span className="text-xs text-muted-foreground">{r.dueDate}</span>}
                        <Badge variant="outline" className="text-xs capitalize">{r.status}</Badge>
                      </div>
                    </div>
                  ))}
                  {inactiveRfps.length > 0 && (
                    <CollapsibleSection
                      title={`${inactiveRfps.length} closed RFP${inactiveRfps.length !== 1 ? "s" : ""}`}
                      icon={<></>}
                      defaultOpen={false}
                      testId="toggle-older-rfps"
                    >
                      <div className="space-y-1 mt-1">
                        {inactiveRfps.map(r => (
                          <div key={r.id} className="flex items-center justify-between text-sm gap-2 opacity-60">
                            <span className="line-clamp-1">{r.title}</span>
                            <Badge variant="outline" className="text-xs capitalize shrink-0">{r.status}</Badge>
                          </div>
                        ))}
                      </div>
                    </CollapsibleSection>
                  )}
                  {companyAwards.map(a => (
                    <div key={a.id} className="flex items-center justify-between text-sm gap-2">
                      <span className="line-clamp-1">{a.title}</span>
                      <Badge className="text-xs bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 shrink-0">Award</Badge>
                    </div>
                  ))}
                </div>
              </CollapsibleSection>
            )}

            {/* Relationship Freight */}
            {relFreightData?.contacts && relFreightData.contacts.some((c: any) => c.loads > 0 || c.laneCount > 0) && (
              <CollapsibleSection
                title="Relationship Freight"
                icon={<TrendingUp className="h-3.5 w-3.5" />}
                defaultOpen={false}
                testId="toggle-rel-freight"
              >
                <div className="space-y-1 mt-2 text-sm">
                  {relFreightData.contacts.filter((c: any) => c.loads > 0 || c.laneCount > 0).map((rc: any) => (
                    <div key={rc.id} className="flex items-center justify-between gap-2">
                      <span className="font-medium">{rc.name}</span>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
                        {rc.laneCount > 0 && <span>{rc.laneCount} lanes</span>}
                        {rc.loads > 0 && <span>{rc.loads} loads</span>}
                        {rc.margin > 0 && <span className="text-emerald-600 dark:text-emerald-400">${(rc.margin / 1000).toFixed(1)}k</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </CollapsibleSection>
            )}

            {/* Account Health */}
            {healthScore && (
              <CollapsibleSection
                title={`Account Health — ${healthScore.grade} (${healthScore.score}/100)`}
                icon={<Activity className="h-3.5 w-3.5" />}
                defaultOpen={false}
                testId="toggle-health"
              >
                <div className="mt-2 space-y-3">
                  {narrativeLoading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> Generating narrative…
                    </div>
                  ) : healthNarrativeData?.narrative ? (
                    <p className="text-sm text-muted-foreground italic leading-relaxed border-l-2 border-primary/30 pl-3">
                      {healthNarrativeData.narrative}
                    </p>
                  ) : null}
                  <div className="space-y-1.5">
                    {healthScore.factors.map(f => (
                      <div key={f.name} className="flex items-center gap-3 text-sm">
                        <div className="w-36 text-xs text-muted-foreground shrink-0">{f.name}</div>
                        <div className="flex-1 bg-muted rounded-full h-1.5">
                          <div
                            className={`h-1.5 rounded-full ${f.score >= f.max * 0.8 ? "bg-green-500" : f.score >= f.max * 0.5 ? "bg-blue-500" : f.score >= f.max * 0.2 ? "bg-amber-500" : "bg-red-500"}`}
                            style={{ width: `${(f.score / f.max) * 100}%` }}
                          />
                        </div>
                        <div className="text-xs font-medium w-12 text-right shrink-0">{f.score}/{f.max}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </CollapsibleSection>
            )}

            {/* Generate Talking Points — on-demand */}
            <CollapsibleSection
              title="Generate Talking Points"
              icon={<Sparkles className="h-3.5 w-3.5" />}
              defaultOpen={false}
              testId="toggle-talking-points"
            >
              <div className="mt-2">
                {talkingPoints.length === 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={generateTalkingPoints}
                    disabled={loadingPoints}
                    data-testid="button-ai-talking-points"
                  >
                    {loadingPoints
                      ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                      : <Sparkles className="h-4 w-4 mr-1.5 text-purple-500" />}
                    {loadingPoints ? "Generating…" : "Generate with AI"}
                  </Button>
                ) : (
                  <div className="bg-purple-50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800 rounded-lg p-3">
                    <ol className="space-y-1.5">
                      {talkingPoints.map((pt, i) => (
                        <li key={i} className="flex gap-2 text-sm" data-testid={`precall-talking-point-${i}`}>
                          <span className="font-bold text-purple-600 dark:text-purple-400 shrink-0">{i + 1}.</span>
                          <span>{pt}</span>
                        </li>
                      ))}
                    </ol>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2 text-xs text-muted-foreground h-7"
                      onClick={generateTalkingPoints}
                      disabled={loadingPoints}
                    >
                      {loadingPoints ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                      Regenerate
                    </Button>
                  </div>
                )}
              </div>
            </CollapsibleSection>

          </div>

          {/* ── STICKY FOOTER ──────────────────────────────────────────────── */}
          <div className="shrink-0 border-t bg-background/95 backdrop-blur-sm px-5 py-3 flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={() => openLogTouch("call")}
              data-testid="button-footer-log-call"
              className="flex items-center gap-1.5"
            >
              <Phone className="h-3.5 w-3.5" /> Log Call
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => openLogTouch("email")}
              data-testid="button-footer-log-email"
              className="flex items-center gap-1.5"
            >
              <Mail className="h-3.5 w-3.5" /> Log Email
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTaskOpen(true)}
              data-testid="button-footer-create-task"
              className="flex items-center gap-1.5"
            >
              <ClipboardList className="h-3.5 w-3.5" /> Create Task
            </Button>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              onClick={handlePrint}
              data-testid="button-print-precall"
              className="flex items-center gap-1.5 text-muted-foreground"
            >
              <Printer className="h-3.5 w-3.5" /> Print
            </Button>
          </div>

        </DialogContent>
      </Dialog>

      {/* ── Log Touch Dialog ─────────────────────────────────────────────── */}
      <Dialog open={logOpen} onOpenChange={v => { if (!v) setLogOpen(false); }}>
        <DialogContent className="sm:max-w-sm" data-testid="dialog-precall-log-touch">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Phone className="h-4 w-4 text-primary" />
              Log Touch — {company.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-1">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Contact</label>
              <Select value={logContactId} onValueChange={setLogContactId}>
                <SelectTrigger data-testid="select-precall-touch-contact">
                  <SelectValue placeholder="Pick a contact" />
                </SelectTrigger>
                <SelectContent>
                  {contacts.map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.name}{c.title ? ` · ${c.title}` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Touch Type</label>
              <div className="flex gap-2">
                {[
                  { value: "call", label: "Call" },
                  { value: "email", label: "Email" },
                  { value: "text", label: "Text" },
                  { value: "site_visit", label: "Site Visit" },
                ].map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setLogType(opt.value)}
                    data-testid={`button-precall-touch-type-${opt.value}`}
                    className={`flex-1 py-1.5 text-xs rounded-md border transition-colors ${
                      logType === opt.value
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3 py-1">
              <button
                type="button"
                onClick={() => setLogMeaningful(v => !v)}
                data-testid="button-precall-meaningful-toggle"
                className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${logMeaningful ? "bg-green-500" : "bg-muted border border-border"}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${logMeaningful ? "left-4" : "left-0.5"}`} />
              </button>
              <span className="text-xs font-medium">Meaningful conversation?</span>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Notes{logMeaningful
                  ? <span className="text-red-500 ml-1">*required</span>
                  : <span className="font-normal ml-1">(optional)</span>
                }
              </label>
              <textarea
                value={logNote}
                onChange={e => setLogNote(e.target.value)}
                placeholder={logMeaningful ? "What made this conversation meaningful?" : "What did you discuss?"}
                rows={3}
                data-testid="textarea-precall-touch-note"
                className={`w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none ${
                  logMeaningful && !logNote.trim() ? "border-red-300 dark:border-red-700" : "border-input"
                }`}
              />
            </div>

            <div className="flex gap-2 items-center">
              {[
                { value: "positive", label: "😊" },
                { value: "neutral",  label: "😐" },
                { value: "negative", label: "😟" },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setLogSentiment(logSentiment === opt.value ? "" : opt.value)}
                  data-testid={`button-precall-sentiment-${opt.value}`}
                  className={`flex-1 py-1 text-sm rounded-md border transition-colors ${
                    logSentiment === opt.value
                      ? "bg-primary/10 border-primary text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
              <span className="text-xs text-muted-foreground ml-1 shrink-0">Vibe</span>
            </div>

            <Button
              className="w-full"
              disabled={!logContactId || logTouchMutation.isPending || (logMeaningful && !logNote.trim())}
              onClick={() => logTouchMutation.mutate({
                contactId: logContactId,
                type: logType,
                notes: logNote,
                sentiment: logSentiment,
                isMeaningful: logMeaningful,
              })}
              data-testid="button-precall-submit-touch"
            >
              {logTouchMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Save Touch
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Create Task Dialog ──────────────────────────────────────────── */}
      <Dialog open={taskOpen} onOpenChange={v => { if (!v) setTaskOpen(false); }}>
        <DialogContent className="sm:max-w-sm" data-testid="dialog-precall-create-task">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <ClipboardList className="h-4 w-4 text-primary" />
              Create Task — {company.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-1">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Task</label>
              <input
                type="text"
                value={taskTitle}
                onChange={e => setTaskTitle(e.target.value)}
                placeholder="What needs to get done?"
                data-testid="input-precall-task-title"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Due Date <span className="font-normal">(optional)</span>
              </label>
              <input
                type="date"
                value={taskDue}
                onChange={e => setTaskDue(e.target.value)}
                data-testid="input-precall-task-due"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <Button
              className="w-full"
              disabled={!taskTitle.trim() || createTaskMutation.isPending}
              onClick={() => createTaskMutation.mutate({ title: taskTitle, dueDate: taskDue })}
              data-testid="button-precall-submit-task"
            >
              {createTaskMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Create Task
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ContactIntelModal
        contact={selectedContactForIntel}
        open={!!selectedContactForIntel}
        onClose={() => setSelectedContactForIntel(null)}
      />

      <OutlookComposeDialog
        open={!!composeTarget}
        onClose={() => setComposeTarget(null)}
        toEmail={composeTarget?.email || ""}
        toName={composeTarget?.name || ""}
        companyName={company?.name || ""}
        contactId={composeTarget?.id}
        companyId={composeTarget?.companyId ?? undefined}
      />
    </>
  );
}
