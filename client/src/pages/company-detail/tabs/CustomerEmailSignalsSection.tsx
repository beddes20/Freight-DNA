import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Mail, TrendingUp, AlertCircle, MessageSquare, DollarSign,
  ThumbsUp, ThumbsDown, Zap, Clock, ArrowRight, Inbox,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EmailSignalRow {
  signalId: string;
  intentType: string;
  intentSubtype: string | null;
  actorType: string;
  confidence: number;
  extractedData: Record<string, unknown>;
  signalCreatedAt: string;
  messageId: string;
  direction: string;
  fromEmail: string | null;
  toEmail: string | null;
  subject: string | null;
  messageCreatedAt: string;
  threadId: string | null;
}

// ── Intent meta ────────────────────────────────────────────────────────────────

const INTENT_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  pricing_request:       { label: "Pricing Request",       icon: DollarSign,     color: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200" },
  objection:             { label: "Objection",              icon: AlertCircle,    color: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200" },
  service_complaint:     { label: "Service Complaint",     icon: AlertCircle,    color: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200" },
  urgency_signal:        { label: "Urgency Signal",         icon: Zap,            color: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200" },
  stalled_thread:        { label: "Stalled Thread",         icon: Clock,          color: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" },
  meaningful_touchpoint: { label: "Meaningful Touchpoint", icon: MessageSquare,  color: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200" },
  new_opportunity:       { label: "New Opportunity",        icon: TrendingUp,     color: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200" },
  positive_feedback:     { label: "Positive Feedback",      icon: ThumbsUp,       color: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200" },
  closed_won_indicator:  { label: "Won Indicator",          icon: ThumbsUp,       color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" },
  closed_lost_indicator: { label: "Lost Indicator",         icon: ThumbsDown,     color: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200" },
};

function intentMeta(type: string) {
  return INTENT_META[type] ?? { label: type.replace(/_/g, " "), icon: Mail, color: "bg-muted text-muted-foreground" };
}

function formatAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Summary pills ──────────────────────────────────────────────────────────────

function SummaryPills({ signals }: { signals: EmailSignalRow[] }) {
  const counts: Record<string, number> = {};
  for (const s of signals) {
    counts[s.intentType] = (counts[s.intentType] ?? 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-4">
      {entries.map(([type, count]) => {
        const meta = intentMeta(type);
        const Icon = meta.icon;
        return (
          <span
            key={type}
            className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium", meta.color)}
            data-testid={`pill-intent-${type}`}
          >
            <Icon className="h-3 w-3" />
            {count} {meta.label}{count !== 1 ? "s" : ""}
          </span>
        );
      })}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function CustomerEmailSignalsSection({ companyId }: { companyId: string }) {
  const { data: signals = [], isLoading } = useQuery<EmailSignalRow[]>({
    queryKey: ["/api/companies", companyId, "email-signals"],
    queryFn: () => fetch(`/api/companies/${companyId}/email-signals`).then(r => r.json()),
    staleTime: 2 * 60 * 1000,
  });

  return (
    <Card data-testid="card-customer-email-signals">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Mail className="h-4 w-4 text-primary" />
          Customer Email Intelligence
          {!isLoading && signals.length > 0 && (
            <Badge variant="secondary" className="ml-auto text-xs" data-testid="badge-signal-count">
              {signals.length} signal{signals.length !== 1 ? "s" : ""}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : signals.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground" data-testid="email-signals-empty">
            <Inbox className="h-8 w-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm font-medium">No email signals yet</p>
            <p className="text-xs mt-1 max-w-xs mx-auto">
              Once your team's outbound emails to this account's contacts are tracked through the central mailbox,
              AI-extracted signals will appear here.
            </p>
          </div>
        ) : (
          <>
            <SummaryPills signals={signals} />
            <div className="space-y-2">
              {signals.map((signal) => {
                const meta = intentMeta(signal.intentType);
                const Icon = meta.icon;
                const isInbound = signal.direction === "inbound";
                return (
                  <div
                    key={signal.signalId}
                    className="flex items-start gap-3 rounded-md border bg-muted/20 px-3 py-2.5 hover:bg-muted/40 transition-colors"
                    data-testid={`row-email-signal-${signal.signalId}`}
                  >
                    <span className={cn("inline-flex items-center justify-center h-7 w-7 rounded-full shrink-0", meta.color)}>
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={cn("text-xs font-semibold px-1.5 py-0.5 rounded", meta.color)} data-testid={`badge-intent-${signal.signalId}`}>
                          {meta.label}
                        </span>
                        {signal.intentSubtype && (
                          <span className="text-xs text-muted-foreground">· {signal.intentSubtype}</span>
                        )}
                        <span className="ml-auto text-xs text-muted-foreground shrink-0">{formatAgo(signal.signalCreatedAt)}</span>
                      </div>
                      {signal.subject && (
                        <p className="text-xs text-foreground/80 mt-0.5 truncate" data-testid={`text-subject-${signal.signalId}`}>
                          {signal.subject}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <ArrowRight className={cn("h-3 w-3", isInbound ? "rotate-180 text-blue-500" : "text-green-500")} />
                          {isInbound ? signal.fromEmail : `To: ${signal.toEmail}`}
                        </span>
                        <span className="text-xs text-muted-foreground ml-auto">
                          {signal.confidence}% confidence
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
