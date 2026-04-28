import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell
} from "recharts";
import {
  BrainCircuit, AlertTriangle, CheckCircle2, XCircle, TrendingUp, Activity,
  Clock, Building2, Mail, Zap, RefreshCw, ChevronRight, ArrowUpRight, BarChart2,
  Lightbulb, UserPlus, MapPin, Wrench, Sparkles, Inbox
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ThreadDetailPanel, type ConversationThread } from "@/pages/conversations";
import ResponseTimeTab from "@/components/email-intelligence/response-time-tab";
import { IntegrationDegradedPill } from "@/components/integration-degraded-pill";
import { useAuth } from "@/hooks/use-auth";

// Mirrors ALLOWED_ROLES on the server (server/routes/emailAnalytics.ts) and the
// sidebar role gate. Kept at module scope so it's easy to keep in sync.
const EMAIL_INTELLIGENCE_ROLES = ["admin", "director", "national_account_manager", "sales_director"];

interface SignalSummaryRow {
  intent_type: string;
  total: number;
  inbound_count: number;
  outbound_count: number;
  avg_confidence: number;
}

interface WinLossRow {
  intent_type: string;
  total: number;
  won: number;
  lost: number;
}

interface RecentSignal {
  signal_id: string;
  intent_type: string;
  intent_subtype: string | null;
  confidence: number;
  actor_type: string | null;
  signal_at: string;
  direction: string;
  from_email: string | null;
  subject: string | null;
  linked_account_id: string | null;
  linked_carrier_id: string | null;
  company_name: string | null;
  carrier_name: string | null;
}

interface UrgencySignal {
  signal_id: string;
  confidence: number;
  signal_at: string;
  subject: string | null;
  from_email: string | null;
  linked_account_id: string | null;
  company_name: string | null;
  hours_elapsed: number;
  touchpoints_after: number;
  responded: boolean;
}

interface EmailIntelligenceData {
  signal_summary: SignalSummaryRow[];
  win_loss_patterns: WinLossRow[];
  recent_signals: RecentSignal[];
  urgency_signals: UrgencySignal[];
}

interface LearnedTodayContactSuggestion {
  id: string;
  email_address: string;
  suggested_name: string | null;
  suggested_title: string | null;
  suggestion_source: string;
  confidence_score: number;
  thread_count: number;
  notes: string | null;
  created_at: string;
  account_name: string | null;
}

interface LearnedTodaySparkSignal {
  signal_id: string;
  intent_type: string;
  confidence: number;
  extracted_data: Record<string, unknown> | null;
  signal_at: string;
  subject: string | null;
  from_email: string | null;
  linked_account_id: string | null;
  company_name: string | null;
}

interface LearnedTodayEnrichment {
  id: string;
  suggestion_type: string;
  confidence: number;
  payload: Record<string, unknown> | null;
  created_at: string;
  carrier_name: string | null;
}

interface LearnedTodayData {
  new_contact_suggestions: LearnedTodayContactSuggestion[];
  conversation_sparks: LearnedTodaySparkSignal[];
  enrichment_updates: LearnedTodayEnrichment[];
  geography_inferences: LearnedTodaySparkSignal[];
  summary: {
    contacts_suggested: number;
    sparks_generated: number;
    enrichments_staged: number;
    geographies_inferred: number;
  };
}

const INTENT_LABELS: Record<string, string> = {
  lane_offer: "Lane Offer",
  lane_decline: "Lane Decline",
  capacity_available: "Capacity Available",
  capacity_unavailable: "Capacity Unavailable",
  new_lane_preference: "New Lane Preference",
  price_pushback: "Price Pushback",
  service_issue: "Service Issue",
  soft_commitment: "Soft Commitment",
  hard_commitment: "Hard Commitment",
  pricing_request: "Pricing Request",
  objection: "Objection",
  service_complaint: "Service Complaint",
  urgency_signal: "Urgency Signal",
  stalled_thread: "Stalled Thread",
  meaningful_touchpoint: "Meaningful Touchpoint",
  new_opportunity: "New Opportunity",
  positive_feedback: "Positive Feedback",
  closed_won_indicator: "Closed Won",
  closed_lost_indicator: "Closed Lost",
  conversation_spark_adhoc_to_structured: "Spark: Ad Hoc → Structured",
  conversation_spark_new_stakeholder: "Spark: New Stakeholder",
  conversation_spark_geography_expansion: "Spark: Geography Expansion",
};

const INTENT_COLORS: Record<string, string> = {
  lane_offer: "#3b82f6",
  lane_decline: "#ef4444",
  capacity_available: "#22c55e",
  capacity_unavailable: "#f97316",
  new_lane_preference: "#a855f7",
  price_pushback: "#eab308",
  service_issue: "#f97316",
  soft_commitment: "#06b6d4",
  hard_commitment: "#10b981",
  pricing_request: "#8b5cf6",
  objection: "#f59e0b",
  service_complaint: "#ef4444",
  urgency_signal: "#dc2626",
  stalled_thread: "#6b7280",
  new_opportunity: "#22c55e",
  closed_won_indicator: "#16a34a",
  closed_lost_indicator: "#b91c1c",
  conversation_spark_adhoc_to_structured: "#f59e0b",
  conversation_spark_new_stakeholder: "#8b5cf6",
  conversation_spark_geography_expansion: "#14b8a6",
};

function label(type: string) {
  return INTENT_LABELS[type] ?? type.replace(/_/g, " ");
}

function IntentBadge({ type }: { type: string }) {
  const color = INTENT_COLORS[type] ?? "#6b7280";
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
      style={{ backgroundColor: color }}
    >
      {label(type)}
    </span>
  );
}

function SignalSummaryCard({ row }: { row: SignalSummaryRow }) {
  const color = INTENT_COLORS[row.intent_type] ?? "#6b7280";
  return (
    <div className="rounded-lg border border-border bg-card p-3 flex items-start gap-3" data-testid={`signal-card-${row.intent_type}`}>
      <div className="w-2 h-full min-h-[48px] rounded-full shrink-0" style={{ backgroundColor: color }} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">{label(row.intent_type)}</div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xl font-bold" style={{ color }}>{row.total}</span>
          <span className="text-xs text-muted-foreground">signals</span>
          <span className="text-xs text-muted-foreground">· {row.avg_confidence}% avg confidence</span>
        </div>
        <div className="flex gap-2 mt-1">
          {row.inbound_count > 0 && <span className="text-[10px] text-muted-foreground">↓ {row.inbound_count} inbound</span>}
          {row.outbound_count > 0 && <span className="text-[10px] text-muted-foreground">↑ {row.outbound_count} outbound</span>}
        </div>
      </div>
    </div>
  );
}

function UrgencyRow({ u, onClick }: { u: UrgencySignal; onClick: () => void }) {
  const hours = u.hours_elapsed;
  const isHot = hours < 4;
  const isWarm = hours < 24;
  const urgencyColor = u.responded ? "text-green-500" : isHot ? "text-red-500" : isWarm ? "text-amber-500" : "text-muted-foreground";
  const urgencyLabel = u.responded ? "Responded" : isHot ? "Urgent" : isWarm ? "Needs Attention" : "Overdue";
  const urgencyBg = u.responded ? "bg-green-500/10 border-green-500/20" : isHot ? "bg-red-500/10 border-red-500/20" : isWarm ? "bg-amber-500/10 border-amber-500/20" : "bg-muted/30 border-border";

  return (
    <div
      className={`rounded-lg border p-3 cursor-pointer hover:opacity-80 transition-opacity ${urgencyBg}`}
      onClick={onClick}
      data-testid={`urgency-row-${u.signal_id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-foreground truncate">
              {u.company_name ?? u.from_email ?? "Unknown Account"}
            </span>
            <Badge variant="outline" className={`text-[10px] shrink-0 ${urgencyColor}`}>
              {urgencyLabel}
            </Badge>
          </div>
          {u.subject && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">"{u.subject}"</p>
          )}
          <div className="flex items-center gap-3 mt-1">
            <span className={`text-xs font-medium flex items-center gap-1 ${urgencyColor}`}>
              <Clock className="w-3 h-3" />
              {hours < 1 ? "< 1 hr ago" : `${hours.toFixed(1)} hrs ago`}
            </span>
            {u.responded && (
              <span className="text-xs text-green-500 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                {u.touchpoints_after} touchpoint{u.touchpoints_after !== 1 ? "s" : ""} logged
              </span>
            )}
          </div>
        </div>
        {u.linked_account_id && (
          <ArrowUpRight className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
        )}
      </div>
    </div>
  );
}

type DrilldownOutcome = "won" | "lost" | "neutral" | "all";

interface DrilldownThread extends ConversationThread {
  subject: string | null;
  fromEmail: string | null;
  toEmail: string | null;
  ccEmail: string | null;
  lastMessageAt: string | null;
  companyName: string | null;
  carrierName: string | null;
  outcome: "won" | "lost" | "neutral";
}

function outcomeBadgeClass(outcome: "won" | "lost" | "neutral"): string {
  if (outcome === "won") return "text-green-600 border-green-500/30 bg-green-500/10";
  if (outcome === "lost") return "text-red-600 border-red-500/30 bg-red-500/10";
  return "text-muted-foreground border-border bg-muted/30";
}

function WinLossDrilldownDialog({
  intentType,
  outcome,
  onClose,
}: {
  intentType: string | null;
  outcome: DrilldownOutcome;
  onClose: () => void;
}) {
  const [selectedThread, setSelectedThread] = useState<DrilldownThread | null>(null);

  const enabled = !!intentType;
  const { data, isLoading, error } = useQuery<{ threads: DrilldownThread[]; count: number }>({
    queryKey: ["/api/analytics/email-intelligence/drilldown", intentType, outcome],
    enabled,
    queryFn: async () => {
      const params = new URLSearchParams({ intent_type: intentType!, outcome });
      const r = await fetch(`/api/analytics/email-intelligence/drilldown?${params.toString()}`);
      if (!r.ok) throw new Error("Failed to load drilldown");
      return r.json();
    },
    staleTime: 60 * 1000,
  });

  const outcomeText = outcome === "all" ? "all outcomes" : outcome.charAt(0).toUpperCase() + outcome.slice(1);
  const threads = data?.threads ?? [];

  return (
    <>
      <Dialog open={!!intentType} onOpenChange={open => { if (!open) onClose(); }}>
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col" data-testid="dialog-winloss-drilldown">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Inbox className="w-4 h-4 text-amber-500" />
              {intentType ? label(intentType) : ""} <span className="text-muted-foreground font-normal text-sm">· {outcomeText}</span>
            </DialogTitle>
            <DialogDescription className="text-xs">
              Email threads contributing to this signal type{outcome !== "all" ? ` and ${outcome} outcome` : ""}.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto -mx-6 px-6">
            {isLoading ? (
              <div className="space-y-2 py-2">
                {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
              </div>
            ) : error ? (
              <div className="py-12 text-center text-sm text-destructive" data-testid="drilldown-error">
                Failed to load drilldown. Please try again.
              </div>
            ) : threads.length === 0 ? (
              <div className="py-12 text-center" data-testid="drilldown-empty">
                <Inbox className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm font-medium text-foreground">No emails in this category yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Threads with this signal type and outcome will appear here.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {threads.map(t => {
                  const dateIso = t.lastMessageAt ?? t.updatedAt;
                  const accountLabel = t.companyName ?? t.carrierName ?? t.fromEmail ?? "Unknown";
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setSelectedThread(t)}
                      className="w-full text-left px-3 py-3 hover:bg-muted/40 transition-colors flex items-start gap-3 cursor-pointer"
                      data-testid={`drilldown-thread-${t.id}`}
                    >
                      <Mail className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-foreground truncate" data-testid={`drilldown-subject-${t.id}`}>
                            {t.subject ?? "(no subject)"}
                          </span>
                          <Badge variant="outline" className={`text-[10px] px-1.5 ${outcomeBadgeClass(t.outcome)}`}>
                            {t.outcome === "won" ? "Won" : t.outcome === "lost" ? "Lost" : "Neutral"}
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5 truncate">
                          {accountLabel}
                          {t.fromEmail && t.fromEmail !== accountLabel && (
                            <span className="ml-1">· {t.fromEmail}</span>
                          )}
                        </div>
                        {dateIso && (
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {formatDistanceToNow(new Date(dateIso), { addSuffix: true })}
                          </div>
                        )}
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 mt-1" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {!isLoading && threads.length > 0 && (
            <div className="text-xs text-muted-foreground border-t pt-2">
              {threads.length} thread{threads.length === 1 ? "" : "s"}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {selectedThread && (
        <ThreadDetailPanel thread={selectedThread} onClose={() => setSelectedThread(null)} readOnly />
      )}
    </>
  );
}

export default function EmailIntelligencePage() {
  // Page-level role guard. Until Task #742 the AI Hub's outer guard caught
  // unauthorized users; now that this page is a standalone route, we have
  // to enforce the same restriction ourselves so a user can't bypass the
  // hidden sidebar entry by typing /email-intelligence directly. The server
  // still returns 403 either way — this is a UI guard so we don't render
  // empty card chrome on top of a forbidden response. Guard lives on the
  // outer wrapper so the inner component's hooks only mount for permitted
  // users (preserves Rules of Hooks).
  const { user } = useAuth();
  if (user && !EMAIL_INTELLIGENCE_ROLES.includes(user.role)) {
    return (
      <div className="p-8" data-testid="email-intelligence-forbidden">
        <Card>
          <CardContent className="p-8 text-center space-y-2">
            <AlertTriangle className="h-10 w-10 text-amber-500 mx-auto" />
            <p className="font-semibold">Email Intelligence isn't available for your role</p>
            <p className="text-sm text-muted-foreground">
              Ask an admin if you should have access to email signal analytics.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }
  return <EmailIntelligencePageInner />;
}

function EmailIntelligencePageInner() {
  const [, navigate] = useLocation();
  const [drilldown, setDrilldown] = useState<{ intentType: string; outcome: DrilldownOutcome } | null>(null);

  const openDrilldown = (intentType: string, outcome: DrilldownOutcome) => {
    setDrilldown({ intentType, outcome });
  };

  // Task #799: keep the dashboard fresh on a 5-minute cadence so reps don't
  // have to mash the Refresh button to see newly-ingested signals. The
  // ingestion cron runs every 2 minutes; this client-side interval matches
  // the 60s server cache + typical ingest latency closely enough that a
  // signal captured on the server appears in the Recent Feed within ~5 min
  // of its arrival.
  //
  // React Query defaults that we intentionally rely on (no overrides needed):
  //   - refetchInterval pauses while the tab is hidden (we do NOT set
  //     refetchIntervalInBackground=true), so a backgrounded tab stops
  //     hammering the API.
  //   - refetchOnWindowFocus=true + staleTime=5min means returning to a
  //     tab that's been away for ≥5 min triggers an immediate refetch.
  //   - refetchOnReconnect=true picks data back up after a network blip.
  //   - calling refetch() from the manual Refresh button resets the
  //     interval timer, so the next auto-refresh is 5 min after the manual
  //     pull rather than firing on top of it.
  const AUTO_REFRESH_MS = 5 * 60 * 1000;

  const { data, isLoading, error, refetch } = useQuery<EmailIntelligenceData>({
    queryKey: ["/api/analytics/email-intelligence"],
    queryFn: async () => {
      const r = await fetch("/api/analytics/email-intelligence");
      if (!r.ok) throw new Error("Failed to load analytics");
      return r.json();
    },
    staleTime: AUTO_REFRESH_MS,
    refetchInterval: AUTO_REFRESH_MS,
  });

  const { data: learnedData, isLoading: learnedLoading, refetch: refetchLearned } = useQuery<LearnedTodayData>({
    queryKey: ["/api/analytics/email-learned-today"],
    queryFn: async () => {
      const r = await fetch("/api/analytics/email-learned-today");
      if (!r.ok) throw new Error("Failed to load daily digest");
      return r.json();
    },
    staleTime: AUTO_REFRESH_MS,
    refetchInterval: AUTO_REFRESH_MS,
  });

  // Manual Refresh pulls BOTH datasets so the "Today" digest tile stays in
  // step with the rest of the dashboard. Previously it only refetched the
  // main analytics query, which left the Learned Today card potentially
  // stale until its own 5-min interval ticked.
  const refreshAll = () => {
    refetch();
    refetchLearned();
  };

  const urgencyUnresponded = data?.urgency_signals.filter(u => !u.responded) ?? [];
  const urgencyResponded = data?.urgency_signals.filter(u => u.responded) ?? [];

  const winLossChartData = (data?.win_loss_patterns ?? [])
    .filter(r => r.won > 0 || r.lost > 0)
    .map(r => ({
      name: label(r.intent_type),
      type: r.intent_type,
      Won: r.won,
      Lost: r.lost,
      Neutral: Math.max(0, r.total - r.won - r.lost),
    }));

  const signalChartData = (data?.signal_summary ?? [])
    .slice(0, 10)
    .map(r => ({
      name: label(r.intent_type),
      Count: r.total,
      type: r.intent_type,
    }));

  return (
    <div className="flex-1 overflow-y-auto bg-background">
      {/* Hero header */}
      <div className="bg-black border-b border-border px-6 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <BrainCircuit className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2">
                Email Intelligence
                <IntegrationDegradedPill source="graph" label="Outlook" />
              </h1>
              <p className="text-sm text-zinc-400">Win/loss patterns, urgency signals, and email-derived insights</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={refreshAll}
            className="text-zinc-300 border-zinc-600 hover:bg-zinc-700"
            data-testid="refresh-analytics"
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Refresh
          </Button>
        </div>

        {/* KPI row */}
        {isLoading ? (
          <div className="grid grid-cols-4 gap-3 mt-4">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 rounded-lg bg-zinc-700/50" />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            {[
              {
                label: "Total Signals",
                value: data?.signal_summary.reduce((s, r) => s + r.total, 0) ?? 0,
                icon: Activity,
                color: "text-amber-400",
              },
              {
                label: "Urgency Unresponded",
                value: urgencyUnresponded.length,
                icon: AlertTriangle,
                color: urgencyUnresponded.length > 0 ? "text-red-400" : "text-green-400",
              },
              {
                label: "Win Signals Linked",
                value: data?.win_loss_patterns.reduce((s, r) => s + r.won, 0) ?? 0,
                icon: CheckCircle2,
                color: "text-green-400",
              },
              {
                label: "Loss Signals Linked",
                value: data?.win_loss_patterns.reduce((s, r) => s + r.lost, 0) ?? 0,
                icon: XCircle,
                color: "text-red-400",
              },
            ].map(kpi => (
              <div key={kpi.label} className="bg-zinc-800/60 rounded-lg p-3 border border-zinc-700">
                <div className="flex items-center gap-2 mb-1">
                  <kpi.icon className={`w-4 h-4 ${kpi.color}`} />
                  <span className="text-xs text-zinc-400">{kpi.label}</span>
                </div>
                <div className={`text-2xl font-bold ${kpi.color}`}>{kpi.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="p-4 md:p-6 space-y-4 md:space-y-6">
        <Tabs defaultValue="urgency" className="w-full">
          <TabsList className="bg-muted/30 mb-4">
            <TabsTrigger value="urgency" data-testid="tab-urgency">
              <AlertTriangle className="w-3.5 h-3.5 mr-1.5" />
              Urgency Tracker
              {urgencyUnresponded.length > 0 && (
                <Badge variant="destructive" className="ml-1.5 h-4 px-1.5 text-[10px]">{urgencyUnresponded.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="response" data-testid="tab-response-time">
              <Clock className="w-3.5 h-3.5 mr-1.5" />
              Response Time
            </TabsTrigger>
            <TabsTrigger value="winloss" data-testid="tab-winloss">
              <TrendingUp className="w-3.5 h-3.5 mr-1.5" />
              Win/Loss Patterns
            </TabsTrigger>
            <TabsTrigger value="overview" data-testid="tab-overview">
              <BarChart2 className="w-3.5 h-3.5 mr-1.5" />
              Signal Overview
            </TabsTrigger>
            <TabsTrigger value="feed" data-testid="tab-feed">
              <Zap className="w-3.5 h-3.5 mr-1.5" />
              Recent Feed
            </TabsTrigger>
            <TabsTrigger value="learned" data-testid="tab-learned-today">
              <Lightbulb className="w-3.5 h-3.5 mr-1.5" />
              Learned Today
              {learnedData && (learnedData.summary.contacts_suggested + learnedData.summary.sparks_generated + learnedData.summary.enrichments_staged + learnedData.summary.geographies_inferred) > 0 && (
                <Badge variant="secondary" className="ml-1.5 h-4 px-1.5 text-[10px]">
                  {learnedData.summary.contacts_suggested + learnedData.summary.sparks_generated + learnedData.summary.enrichments_staged + learnedData.summary.geographies_inferred}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {/* ── Response Time (Task #414) ─────────────────────────────────── */}
          <TabsContent value="response" className="mt-0">
            <ResponseTimeTab />
          </TabsContent>

          {/* ── Urgency Tracker ───────────────────────────────────────────── */}
          <TabsContent value="urgency" className="mt-0">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle className="w-4 h-4 text-red-500" />
                  <h3 className="font-semibold text-foreground">Needs Response</h3>
                  <Badge variant="destructive" className="text-[10px]">{urgencyUnresponded.length}</Badge>
                </div>
                {isLoading ? (
                  <div className="space-y-2">
                    {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
                  </div>
                ) : urgencyUnresponded.length === 0 ? (
                  <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-6 text-center">
                    <CheckCircle2 className="w-8 h-8 text-green-500 mx-auto mb-2" />
                    <p className="text-sm font-medium text-green-600 dark:text-green-400">All clear!</p>
                    <p className="text-xs text-muted-foreground mt-1">No urgency signals awaiting a response.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {urgencyUnresponded.map(u => (
                      <UrgencyRow
                        key={u.signal_id}
                        u={u}
                        onClick={() => u.linked_account_id && navigate(`/companies/${u.linked_account_id}`)}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center gap-2 mb-3">
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                  <h3 className="font-semibold text-foreground">Responded</h3>
                  <Badge variant="secondary" className="text-[10px]">{urgencyResponded.length}</Badge>
                </div>
                {isLoading ? (
                  <div className="space-y-2">
                    {[...Array(2)].map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
                  </div>
                ) : urgencyResponded.length === 0 ? (
                  <div className="rounded-lg border border-border bg-muted/20 p-6 text-center">
                    <Clock className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">No resolved urgency signals in the last 7 days.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {urgencyResponded.map(u => (
                      <UrgencyRow
                        key={u.signal_id}
                        u={u}
                        onClick={() => u.linked_account_id && navigate(`/companies/${u.linked_account_id}`)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {!isLoading && data?.urgency_signals.length === 0 && (
              <Card className="mt-4 border-border">
                <CardContent className="pt-8 pb-8 text-center">
                  <BrainCircuit className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                  <p className="font-medium text-foreground">No urgency signals yet</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Once customer emails are monitored, urgency signals will appear here for tracking.
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ── Win/Loss Patterns ─────────────────────────────────────────── */}
          <TabsContent value="winloss" className="mt-0">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="border-border">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-amber-500" />
                    Signal Pattern by Outcome
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Which email signal types appear in threads that ended in a win or loss.
                    Signals without linked outcomes are shown as Neutral.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <Skeleton className="h-64 w-full rounded-lg" />
                  ) : winLossChartData.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-48 text-center">
                      <TrendingUp className="w-8 h-8 text-muted-foreground mb-2" />
                      <p className="text-sm text-muted-foreground">No win/loss links yet.</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Patterns appear when email signals are linked to won/lost opportunities.
                      </p>
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={winLossChartData} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                        <XAxis type="number" tick={{ fontSize: 10 }} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={110} />
                        <Tooltip contentStyle={{ fontSize: 12 }} cursor={{ fill: "hsl(var(--muted) / 0.3)" }} />
                        <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                        <Bar
                          dataKey="Won"
                          fill="#22c55e"
                          radius={[0, 3, 3, 0]}
                          cursor="pointer"
                          onClick={(d: { type?: string; payload?: { type?: string } }) => {
                            const t = d?.payload?.type ?? d?.type;
                            if (t) openDrilldown(t, "won");
                          }}
                        />
                        <Bar
                          dataKey="Lost"
                          fill="#ef4444"
                          radius={[0, 3, 3, 0]}
                          cursor="pointer"
                          onClick={(d: { type?: string; payload?: { type?: string } }) => {
                            const t = d?.payload?.type ?? d?.type;
                            if (t) openDrilldown(t, "lost");
                          }}
                        />
                        <Bar
                          dataKey="Neutral"
                          fill="#6b7280"
                          radius={[0, 3, 3, 0]}
                          cursor="pointer"
                          onClick={(d: { type?: string; payload?: { type?: string } }) => {
                            const t = d?.payload?.type ?? d?.type;
                            if (t) openDrilldown(t, "neutral");
                          }}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <Card className="border-border">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold">Pattern Breakdown Table</CardTitle>
                  <CardDescription className="text-xs">
                    Detailed counts per signal type with win/loss split.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  {isLoading ? (
                    <div className="space-y-2 p-4">
                      {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8 w-full rounded" />)}
                    </div>
                  ) : (data?.win_loss_patterns ?? []).length === 0 ? (
                    <div className="p-6 text-center text-sm text-muted-foreground">No pattern data yet.</div>
                  ) : (
                    <div className="divide-y divide-border">
                      {(data?.win_loss_patterns ?? []).map(row => {
                        const winPct = row.total > 0 ? Math.round((row.won / row.total) * 100) : 0;
                        return (
                          <div
                            key={row.intent_type}
                            role="button"
                            tabIndex={0}
                            onClick={() => openDrilldown(row.intent_type, "all")}
                            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDrilldown(row.intent_type, "all"); } }}
                            className="px-4 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-muted/40 transition-colors"
                            data-testid={`winloss-row-${row.intent_type}`}
                          >
                            <div className="w-2 h-6 rounded-full shrink-0" style={{ backgroundColor: INTENT_COLORS[row.intent_type] ?? "#6b7280" }} />
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-medium text-foreground">{label(row.intent_type)}</div>
                              <div className="text-[10px] text-muted-foreground">{row.total} total signals</div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {row.won > 0 && (
                                <button
                                  type="button"
                                  onClick={e => { e.stopPropagation(); openDrilldown(row.intent_type, "won"); }}
                                  className="rounded hover:opacity-80 transition-opacity"
                                  data-testid={`winloss-won-${row.intent_type}`}
                                >
                                  <Badge variant="outline" className="text-[10px] text-green-600 border-green-500/30 px-1.5 cursor-pointer">
                                    {row.won} won
                                  </Badge>
                                </button>
                              )}
                              {row.lost > 0 && (
                                <button
                                  type="button"
                                  onClick={e => { e.stopPropagation(); openDrilldown(row.intent_type, "lost"); }}
                                  className="rounded hover:opacity-80 transition-opacity"
                                  data-testid={`winloss-lost-${row.intent_type}`}
                                >
                                  <Badge variant="outline" className="text-[10px] text-red-600 border-red-500/30 px-1.5 cursor-pointer">
                                    {row.lost} lost
                                  </Badge>
                                </button>
                              )}
                              {winPct > 0 && <span className="text-[10px] text-green-500 font-medium">{winPct}% W</span>}
                              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ── Signal Overview ───────────────────────────────────────────── */}
          <TabsContent value="overview" className="mt-0">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="border-border">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Activity className="w-4 h-4 text-amber-500" />
                    Top Signal Types
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Volume of each email intent signal detected org-wide.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <Skeleton className="h-64 w-full rounded-lg" />
                  ) : signalChartData.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-48 text-center">
                      <Activity className="w-8 h-8 text-muted-foreground mb-2" />
                      <p className="text-sm text-muted-foreground">No signals detected yet.</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Signals will appear as inbound emails are processed.
                      </p>
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={signalChartData} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                        <XAxis type="number" tick={{ fontSize: 10 }} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={110} />
                        <Tooltip contentStyle={{ fontSize: 12 }} />
                        <Bar dataKey="Count" radius={[0, 3, 3, 0]}>
                          {signalChartData.map((entry, index) => (
                            <Cell key={index} fill={INTENT_COLORS[entry.type] ?? "#6b7280"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-foreground px-0.5">Signal Cards</h3>
                {isLoading ? (
                  <div className="space-y-2">
                    {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
                  </div>
                ) : (data?.signal_summary ?? []).length === 0 ? (
                  <div className="rounded-lg border border-border bg-muted/20 p-6 text-center">
                    <p className="text-sm text-muted-foreground">No signals available yet.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {(data?.signal_summary ?? []).map(row => (
                      <SignalSummaryCard key={row.intent_type} row={row} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </TabsContent>

          {/* ── Recent Feed ───────────────────────────────────────────────── */}
          <TabsContent value="feed" className="mt-0">
            <Card className="border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Zap className="w-4 h-4 text-amber-500" />
                  Recent Email Signals
                </CardTitle>
                <CardDescription className="text-xs">Last 30 signals extracted from monitored email threads.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="space-y-2 p-4">
                    {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}
                  </div>
                ) : (data?.recent_signals ?? []).length === 0 ? (
                  <div className="p-8 text-center">
                    <Mail className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                    <p className="font-medium text-foreground">No signals yet</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Email signals will populate here once the monitoring mailbox is active.
                    </p>
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {(data?.recent_signals ?? []).map(sig => (
                      <div
                        key={sig.signal_id}
                        className="px-4 py-3 flex items-start gap-3 hover:bg-muted/20 transition-colors cursor-pointer"
                        onClick={() => {
                          if (sig.linked_account_id) navigate(`/companies/${sig.linked_account_id}`);
                          else if (sig.linked_carrier_id) navigate(`/carrier-hub`);
                        }}
                        data-testid={`signal-row-${sig.signal_id}`}
                      >
                        <div className="shrink-0 mt-0.5">
                          {sig.linked_account_id ? (
                            <Building2 className="w-4 h-4 text-amber-400" />
                          ) : (
                            <Mail className="w-4 h-4 text-amber-400" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <IntentBadge type={sig.intent_type} />
                            <span className="text-xs text-foreground font-medium truncate">
                              {sig.company_name ?? sig.carrier_name ?? sig.from_email ?? "Unknown"}
                            </span>
                            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                              {formatDistanceToNow(new Date(sig.signal_at), { addSuffix: true })}
                            </span>
                          </div>
                          {sig.subject && (
                            <p className="text-[11px] text-muted-foreground mt-0.5 truncate">"{sig.subject}"</p>
                          )}
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] text-muted-foreground capitalize">{sig.direction}</span>
                            <span className="text-[10px] text-muted-foreground">· {sig.confidence}% confidence</span>
                            {sig.intent_subtype && (
                              <span className="text-[10px] text-muted-foreground">· {sig.intent_subtype}</span>
                            )}
                          </div>
                        </div>
                        {(sig.linked_account_id || sig.linked_carrier_id) && (
                          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── What Email Learned Today ──────────────────────────────────── */}
          <TabsContent value="learned" className="mt-0">
            {learnedLoading ? (
              <div className="space-y-4">
                {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-32 rounded-lg" />)}
              </div>
            ) : (
              <div className="space-y-6">
                {/* Summary KPIs */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: "Contacts Suggested", value: learnedData?.summary.contacts_suggested ?? 0, icon: UserPlus, color: "text-amber-500" },
                    { label: "Conversation Sparks", value: learnedData?.summary.sparks_generated ?? 0, icon: Sparkles, color: "text-amber-500" },
                    { label: "Enrichments Staged", value: learnedData?.summary.enrichments_staged ?? 0, icon: Wrench, color: "text-purple-500" },
                    { label: "Geographies Inferred", value: learnedData?.summary.geographies_inferred ?? 0, icon: MapPin, color: "text-teal-500" },
                  ].map(kpi => (
                    <div key={kpi.label} className="rounded-lg border border-border bg-card p-3">
                      <div className="flex items-center gap-2 mb-1">
                        <kpi.icon className={`w-4 h-4 ${kpi.color}`} />
                        <span className="text-xs text-muted-foreground">{kpi.label}</span>
                      </div>
                      <div className={`text-2xl font-bold ${kpi.color}`} data-testid={`learned-kpi-${kpi.label.toLowerCase().replace(/\s+/g, "-")}`}>{kpi.value}</div>
                    </div>
                  ))}
                </div>

                {/* No data state */}
                {learnedData && learnedData.summary.contacts_suggested === 0 && learnedData.summary.sparks_generated === 0 && learnedData.summary.enrichments_staged === 0 && learnedData.summary.geographies_inferred === 0 && (
                  <Card className="border-border">
                    <CardContent className="pt-8 pb-8 text-center">
                      <Lightbulb className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                      <p className="font-medium text-foreground">Nothing new in the last 24 hours</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        The email learning system runs on its 10-minute cycle. Insights will appear here as new emails are processed.
                      </p>
                    </CardContent>
                  </Card>
                )}

                {/* New Contact Suggestions */}
                {(learnedData?.new_contact_suggestions ?? []).length > 0 && (
                  <Card className="border-border">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2">
                        <UserPlus className="w-4 h-4 text-amber-500" />
                        New Contacts Detected
                      </CardTitle>
                      <CardDescription className="text-xs">
                        People discovered in email threads in the last 24 hours
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="p-0">
                      <div className="divide-y divide-border">
                        {(learnedData?.new_contact_suggestions ?? []).map(cs => (
                          <div key={cs.id} className="px-4 py-3 flex items-start gap-3" data-testid={`learned-contact-${cs.id}`}>
                            <UserPlus className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium text-foreground">{cs.email_address}</span>
                                <Badge variant="outline" className="text-[10px]">
                                  {cs.suggestion_source === "email_domain_match" ? "Domain Match" : cs.suggestion_source === "email_thread" ? "Email Thread" : cs.suggestion_source}
                                </Badge>
                                <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                                  {formatDistanceToNow(new Date(cs.created_at), { addSuffix: true })}
                                </span>
                              </div>
                              {(cs.suggested_name || cs.suggested_title) && (
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {cs.suggested_name}{cs.suggested_title && ` · ${cs.suggested_title}`}
                                </p>
                              )}
                              <div className="flex items-center gap-2 mt-0.5">
                                {cs.account_name && (
                                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                                    <Building2 className="w-3 h-3" />
                                    {cs.account_name}
                                  </span>
                                )}
                                <span className="text-[10px] text-muted-foreground">{cs.confidence_score}% confidence</span>
                                {cs.thread_count > 1 && (
                                  <span className="text-[10px] text-muted-foreground">{cs.thread_count} threads</span>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Conversation Sparks */}
                {(learnedData?.conversation_sparks ?? []).length > 0 && (
                  <Card className="border-border">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-amber-500" />
                        Conversation Sparks
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Data-backed outreach opportunities detected from email patterns
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="p-0">
                      <div className="divide-y divide-border">
                        {(learnedData?.conversation_sparks ?? []).map(spark => {
                          const data = spark.extracted_data ?? {};
                          return (
                            <div
                              key={spark.signal_id}
                              className="px-4 py-3 flex items-start gap-3 hover:bg-muted/20 transition-colors cursor-pointer"
                              onClick={() => spark.linked_account_id && navigate(`/companies/${spark.linked_account_id}`)}
                              data-testid={`learned-spark-${spark.signal_id}`}
                            >
                              <Sparkles className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <IntentBadge type={spark.intent_type} />
                                  <span className="text-xs font-medium text-foreground truncate">
                                    {spark.company_name ?? spark.from_email ?? "Unknown"}
                                  </span>
                                  <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                                    {formatDistanceToNow(new Date(spark.signal_at), { addSuffix: true })}
                                  </span>
                                </div>
                                {spark.subject && (
                                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">"{spark.subject}"</p>
                                )}
                                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                  {data.corridor ? <span className="text-[10px] text-foreground/70">Corridor: {String(data.corridor)}</span> : null}
                                  {data.loadCount ? <span className="text-[10px] text-foreground/70">{String(data.loadCount)} loads</span> : null}
                                  {data.stakeholderName ? <span className="text-[10px] text-foreground/70">Stakeholder: {String(data.stakeholderName)}</span> : null}
                                  {data.region ? <span className="text-[10px] text-foreground/70">Region: {String(data.region)}</span> : null}
                                  <span className="text-[10px] text-muted-foreground">{spark.confidence}% confidence</span>
                                </div>
                              </div>
                              {spark.linked_account_id && (
                                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Enrichment Updates */}
                {(learnedData?.enrichment_updates ?? []).length > 0 && (
                  <Card className="border-border">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2">
                        <Wrench className="w-4 h-4 text-purple-500" />
                        Carrier Enrichment Updates
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Profile updates staged from carrier email interactions
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="p-0">
                      <div className="divide-y divide-border">
                        {(learnedData?.enrichment_updates ?? []).map(eu => (
                          <div key={eu.id} className="px-4 py-3 flex items-start gap-3" data-testid={`learned-enrichment-${eu.id}`}>
                            <Wrench className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-medium text-foreground">
                                  {eu.carrier_name ?? "Unknown Carrier"}
                                </span>
                                <Badge variant="outline" className="text-[10px]">
                                  {eu.suggestion_type.replace(/_/g, " ")}
                                </Badge>
                                <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                                  {formatDistanceToNow(new Date(eu.created_at), { addSuffix: true })}
                                </span>
                              </div>
                              <span className="text-[10px] text-muted-foreground">{eu.confidence}% confidence</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Geography Inferences */}
                {(learnedData?.geography_inferences ?? []).length > 0 && (
                  <Card className="border-border">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm font-semibold flex items-center gap-2">
                        <MapPin className="w-4 h-4 text-teal-500" />
                        Geography & Lane Signals
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Freight ownership and lane patterns inferred from email activity
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="p-0">
                      <div className="divide-y divide-border">
                        {(learnedData?.geography_inferences ?? []).map(gi => {
                          const data = gi.extracted_data ?? {};
                          return (
                            <div
                              key={gi.signal_id}
                              className="px-4 py-3 flex items-start gap-3 hover:bg-muted/20 transition-colors cursor-pointer"
                              onClick={() => gi.linked_account_id && navigate(`/companies/${gi.linked_account_id}`)}
                              data-testid={`learned-geo-${gi.signal_id}`}
                            >
                              <MapPin className="w-4 h-4 text-teal-400 mt-0.5 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <IntentBadge type={gi.intent_type} />
                                  <span className="text-xs font-medium text-foreground truncate">
                                    {gi.company_name ?? gi.from_email ?? "Unknown"}
                                  </span>
                                  <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                                    {formatDistanceToNow(new Date(gi.signal_at), { addSuffix: true })}
                                  </span>
                                </div>
                                {gi.subject && (
                                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">"{gi.subject}"</p>
                                )}
                                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                  {data.lane ? <span className="text-[10px] text-foreground/70">Lane: {String(data.lane)}</span> : null}
                                  {data.region ? <span className="text-[10px] text-foreground/70">Region: {String(data.region)}</span> : null}
                                  {data.corridor ? <span className="text-[10px] text-foreground/70">Corridor: {String(data.corridor)}</span> : null}
                                  <span className="text-[10px] text-muted-foreground">{gi.confidence}% confidence</span>
                                </div>
                              </div>
                              {gi.linked_account_id && (
                                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <WinLossDrilldownDialog
        intentType={drilldown?.intentType ?? null}
        outcome={drilldown?.outcome ?? "all"}
        onClose={() => setDrilldown(null)}
      />
    </div>
  );
}
