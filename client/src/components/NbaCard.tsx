import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertTriangle,
  Zap,
  TrendingUp,
  Users,
  CheckCircle2,
  X,
  Clock,
  ChevronDown,
  ChevronUp,
  ArrowRight,
  Link2,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface NbaCardData {
  id: string;
  companyId: string | null;
  companyName: string | null;
  contactId: string | null;
  ruleType: string;
  outcomeType: string;
  confidence: string;
  signalCount: number;
  signalSummary: string[];
  whyThisNow: string;
  suggestedAction: string;
  expectedOutcome: string;
  growthLever: string | null;
  relationshipMove: string | null;
  accountTier: string | null;
  urgencyScore: number;
  status: string;
}

interface NbaCardProps {
  card: NbaCardData;
  onDismissed?: (id: string) => void;
  onActioned?: (id: string) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const RULE_LABELS: Record<string, string> = {
  load_decline:        "Load Decline",
  single_thread_risk:  "Single-Thread Risk",
  stale_account:       "Stale Account",
  overdue_next_action: "Overdue Action",
  spot_to_contract:    "Spot-to-Contract",
};

const OUTCOME_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  protect: { label: "Protect",  color: "bg-red-500/15 text-red-400 border-red-500/25",    icon: <AlertTriangle className="w-3.5 h-3.5" /> },
  execute: { label: "Execute",  color: "bg-amber-500/15 text-amber-400 border-amber-500/25", icon: <Zap className="w-3.5 h-3.5" /> },
  grow:    { label: "Grow",     color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25", icon: <TrendingUp className="w-3.5 h-3.5" /> },
  deepen:  { label: "Deepen",   color: "bg-blue-500/15 text-blue-400 border-blue-500/25",   icon: <Users className="w-3.5 h-3.5" /> },
};

const CONFIDENCE_DOT: Record<string, string> = {
  high:   "bg-emerald-400",
  medium: "bg-amber-400",
};

const DISMISS_OPTIONS = [
  "Already working this",
  "Not a priority this week",
  "Data is incorrect",
  "Account is on hold",
  "Other",
];

// ── Component ─────────────────────────────────────────────────────────────────

export function NbaCard({ card, onDismissed, onActioned }: NbaCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showDismiss, setShowDismiss] = useState(false);
  const [dismissReason, setDismissReason] = useState("");
  const [customDismiss, setCustomDismiss] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const outcome = OUTCOME_CONFIG[card.outcomeType] ?? OUTCOME_CONFIG.execute;

  const resolveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest("PATCH", `/api/nba/cards/${card.id}/resolve`, body),
    onSuccess: (_data: unknown, variables: Record<string, unknown>) => {
      queryClient.invalidateQueries({ queryKey: ["/api/nba/cards"] });
      const action = variables.action as string;
      if (action === "actioned") onActioned?.(card.id);
      if (action === "dismissed") onDismissed?.(card.id);
    },
    onError: () => toast({ title: "Could not update card", variant: "destructive" }),
  });

  function handleAction() {
    resolveMutation.mutate({ action: "actioned" });
    toast({ title: "Marked as actioned", description: `Card for ${card.companyName} closed.` });
  }

  function handleSnooze() {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    resolveMutation.mutate({ action: "snoozed", snoozeUntil: d.toISOString().split("T")[0] });
    toast({ title: "Snoozed 3 days", description: "Card will return in 3 days." });
  }

  function handleDismiss() {
    const reason = dismissReason === "Other" ? customDismiss : dismissReason;
    if (!reason) return;
    resolveMutation.mutate({ action: "dismissed", dismissReason: reason });
    toast({ title: "Card dismissed", description: reason });
    setShowDismiss(false);
  }

  const tierBadge = card.accountTier ? (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${card.accountTier === "A" ? "bg-violet-500/20 text-violet-300" : "bg-slate-500/20 text-slate-300"}`}>
      {card.accountTier}-Tier
    </span>
  ) : null;

  return (
    <div
      className="rounded-xl border border-white/8 bg-white/4 hover:bg-white/6 transition-colors p-4 flex flex-col gap-3"
      data-testid={`nba-card-${card.id}`}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5 flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Outcome badge */}
            <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${outcome.color}`}>
              {outcome.icon}
              {outcome.label}
            </span>
            {/* Rule type */}
            <span className="text-[11px] text-white/40 font-medium">
              {RULE_LABELS[card.ruleType] ?? card.ruleType}
            </span>
            {/* Confidence */}
            <span className="flex items-center gap-1 text-[11px] text-white/40">
              <span className={`w-1.5 h-1.5 rounded-full ${CONFIDENCE_DOT[card.confidence] ?? "bg-slate-400"}`} />
              {card.confidence === "high" ? "High confidence" : "Medium confidence"}
            </span>
            {tierBadge}
          </div>

          {/* Company name */}
          {card.companyName && (
            <a
              href={card.companyId ? `/companies/${card.companyId}` : undefined}
              className="text-sm font-semibold text-white hover:text-amber-400 transition-colors truncate flex items-center gap-1"
              data-testid={`nba-card-company-link-${card.id}`}
            >
              {card.companyName}
              {card.companyId && <Link2 className="w-3 h-3 opacity-40" />}
            </a>
          )}
        </div>

        {/* Signal count pill */}
        <div className="shrink-0 text-[11px] font-semibold bg-white/8 text-white/60 rounded-full px-2 py-0.5 whitespace-nowrap">
          {card.signalCount} signal{card.signalCount !== 1 ? "s" : ""}
        </div>
      </div>

      {/* Why this now */}
      <p className="text-sm text-white/75 leading-snug">{card.whyThisNow}</p>

      {/* Suggested action */}
      <div className="flex items-start gap-2 bg-amber-500/8 rounded-lg px-3 py-2 border border-amber-500/15">
        <ArrowRight className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
        <p className="text-sm text-amber-100/90">{card.suggestedAction}</p>
      </div>

      {/* Expand: signals + expected outcome */}
      {expanded && (
        <div className="flex flex-col gap-3 pt-1">
          {/* Signal list */}
          {card.signalSummary.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-[11px] font-semibold text-white/40 uppercase tracking-wide">Signals</p>
              <ul className="flex flex-col gap-1">
                {card.signalSummary.map((sig, i) => (
                  <li key={i} className="text-xs text-white/60 flex items-start gap-1.5">
                    <span className="mt-1 w-1 h-1 rounded-full bg-white/30 shrink-0" />
                    {sig}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* Expected outcome */}
          <div className="flex flex-col gap-1">
            <p className="text-[11px] font-semibold text-white/40 uppercase tracking-wide">Expected Outcome</p>
            <p className="text-xs text-white/60 leading-snug">{card.expectedOutcome}</p>
          </div>
          {/* Growth lever / relationship move */}
          {(card.growthLever || card.relationshipMove) && (
            <div className="flex flex-wrap gap-2">
              {card.growthLever && (
                <span className="text-[11px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded px-2 py-0.5">
                  Lever: {card.growthLever}
                </span>
              )}
              {card.relationshipMove && (
                <span className="text-[11px] bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded px-2 py-0.5">
                  {card.relationshipMove}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Dismiss picker */}
      {showDismiss && (
        <div className="flex flex-col gap-2 pt-1 border-t border-white/8">
          <p className="text-xs text-white/50 font-medium">Why are you dismissing this?</p>
          <div className="flex flex-wrap gap-1.5">
            {DISMISS_OPTIONS.map(opt => (
              <button
                key={opt}
                onClick={() => setDismissReason(opt)}
                className={`text-xs px-2 py-1 rounded border transition-colors ${
                  dismissReason === opt
                    ? "bg-white/15 border-white/30 text-white"
                    : "bg-white/5 border-white/10 text-white/50 hover:border-white/20"
                }`}
                data-testid={`nba-dismiss-reason-${card.id}-${opt.replace(/\s+/g, "-").toLowerCase()}`}
              >
                {opt}
              </button>
            ))}
          </div>
          {dismissReason === "Other" && (
            <Textarea
              value={customDismiss}
              onChange={e => setCustomDismiss(e.target.value)}
              placeholder="Describe why..."
              className="text-xs h-14 bg-white/5 border-white/15 text-white/80 resize-none"
              data-testid={`nba-dismiss-custom-${card.id}`}
            />
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setShowDismiss(false); setDismissReason(""); }}
              className="h-7 text-xs text-white/40 hover:text-white"
              data-testid={`nba-dismiss-cancel-${card.id}`}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleDismiss}
              disabled={!dismissReason || resolveMutation.isPending}
              className="h-7 text-xs bg-white/10 hover:bg-white/15 text-white/70"
              data-testid={`nba-dismiss-confirm-${card.id}`}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Action row */}
      {!showDismiss && (
        <div className="flex items-center justify-between pt-1 border-t border-white/6">
          {/* Left: expand toggle */}
          <button
            onClick={() => setExpanded(v => !v)}
            className="flex items-center gap-1 text-xs text-white/35 hover:text-white/60 transition-colors"
            data-testid={`nba-card-expand-${card.id}`}
          >
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {expanded ? "Less" : "Details"}
          </button>

          {/* Right: action buttons */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleSnooze}
              disabled={resolveMutation.isPending}
              className="flex items-center gap-1 text-xs text-white/35 hover:text-white/60 transition-colors px-2 py-1"
              data-testid={`nba-card-snooze-${card.id}`}
            >
              <Clock className="w-3.5 h-3.5" />
              Snooze 3d
            </button>
            <button
              onClick={() => setShowDismiss(true)}
              disabled={resolveMutation.isPending}
              className="flex items-center gap-1 text-xs text-white/35 hover:text-red-400 transition-colors px-2 py-1"
              data-testid={`nba-card-dismiss-btn-${card.id}`}
            >
              <X className="w-3.5 h-3.5" />
              Dismiss
            </button>
            <Button
              size="sm"
              onClick={handleAction}
              disabled={resolveMutation.isPending}
              className="h-7 text-xs bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30"
              data-testid={`nba-card-action-${card.id}`}
            >
              <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
