import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { NbaLogTouchDialog } from "./NbaLogTouchDialog";
import {
  AlertTriangle,
  Zap,
  TrendingUp,
  Users,
  CheckCircle2,
  X,
  Clock,
  ArrowRight,
  Link2,
  PhoneCall,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

export interface NbaCardData {
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

export interface NbaCardProps {
  card: NbaCardData;
  /** When true the company name link is suppressed (already in company context) */
  hideCompanyLink?: boolean;
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
  protect: { label: "Protect", color: "bg-red-500/15 text-red-400 border-red-500/25",         icon: <AlertTriangle className="w-3 h-3" /> },
  execute: { label: "Execute", color: "bg-amber-500/15 text-amber-400 border-amber-500/25",    icon: <Zap className="w-3 h-3" /> },
  grow:    { label: "Grow",    color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25", icon: <TrendingUp className="w-3 h-3" /> },
  deepen:  { label: "Deepen",  color: "bg-blue-500/15 text-blue-400 border-blue-500/25",       icon: <Users className="w-3 h-3" /> },
};

const CONFIDENCE_DOT: Record<string, string> = {
  high:   "bg-emerald-400",
  medium: "bg-amber-400",
};

// Canonical dismiss values — value is sent to server; label is shown in UI
const DISMISS_OPTIONS: { value: string; label: string }[] = [
  { value: "already_handled",    label: "Already handled" },
  { value: "situation_changed",  label: "Situation changed" },
  { value: "doesnt_apply",       label: "Doesn't apply" },
  { value: "not_right_priority", label: "Not the right priority" },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function NbaCard({ card, hideCompanyLink = false, onDismissed, onActioned }: NbaCardProps) {
  const [showDismiss, setShowDismiss] = useState(false);
  const [dismissValue, setDismissValue] = useState("");
  const [showLogTouch, setShowLogTouch] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const outcome = OUTCOME_CONFIG[card.outcomeType] ?? OUTCOME_CONFIG.execute;
  // Signal bullets: show max 3 inline
  const bullets = (card.signalSummary ?? []).slice(0, 3);

  const resolveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest("PATCH", `/api/nba/cards/${card.id}/resolve`, body),
    onSuccess: (_: unknown, vars: Record<string, unknown>) => {
      queryClient.invalidateQueries({ queryKey: ["/api/nba/cards"] });
      if (card.companyId) {
        queryClient.invalidateQueries({ queryKey: ["/api/nba/company", card.companyId, "card"] });
      }
      if (vars.action === "actioned")  onActioned?.(card.id);
      if (vars.action === "dismissed") onDismissed?.(card.id);
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
    if (!dismissValue) return;
    resolveMutation.mutate({ action: "dismissed", dismissReason: dismissValue });
    toast({ title: "Card dismissed" });
    setShowDismiss(false);
  }

  // ── Dismiss picker (swaps body, same fixed height region) ─────────────────
  if (showDismiss) {
    return (
      <div
        className="rounded-xl border border-white/8 bg-white/4 p-3 flex flex-col justify-between"
        style={{ minHeight: 128 }}
        data-testid={`nba-card-${card.id}`}
      >
        <p className="text-xs text-white/50 font-medium mb-2">Why are you dismissing this?</p>
        <div className="flex flex-wrap gap-1.5 flex-1">
          {DISMISS_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setDismissValue(opt.value)}
              className={`text-xs px-2 py-1 rounded border transition-colors ${
                dismissValue === opt.value
                  ? "bg-white/15 border-white/30 text-white"
                  : "bg-white/5 border-white/10 text-white/50 hover:border-white/20"
              }`}
              data-testid={`nba-dismiss-reason-${card.id}-${opt.value}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2 mt-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setShowDismiss(false); setDismissValue(""); }}
            className="h-7 text-xs text-white/40 hover:text-white"
            data-testid={`nba-dismiss-cancel-${card.id}`}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleDismiss}
            disabled={!dismissValue || resolveMutation.isPending}
            className="h-7 text-xs bg-white/10 hover:bg-white/15 text-white/70"
            data-testid={`nba-dismiss-confirm-${card.id}`}
          >
            Dismiss
          </Button>
        </div>
      </div>
    );
  }

  // ── Normal fixed-height view ──────────────────────────────────────────────
  return (
    <div
      className="rounded-xl border border-white/8 bg-white/4 hover:bg-white/6 transition-colors p-3 flex flex-col justify-between"
      style={{ minHeight: 128 }}
      data-testid={`nba-card-${card.id}`}
    >
      {/* Top section: badges + company + why */}
      <div className="flex flex-col gap-1.5">
        {/* Badge row */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${outcome.color}`}>
            {outcome.icon}
            {outcome.label}
          </span>
          <span className="text-[10px] text-white/35 font-medium">
            {RULE_LABELS[card.ruleType] ?? card.ruleType}
          </span>
          <span className="flex items-center gap-1 text-[10px] text-white/35">
            <span className={`w-1.5 h-1.5 rounded-full ${CONFIDENCE_DOT[card.confidence] ?? "bg-slate-400"}`} />
            {card.confidence === "high" ? "High" : "Medium"}
          </span>
          {card.accountTier && (
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${card.accountTier === "A" ? "bg-violet-500/20 text-violet-300" : "bg-slate-500/20 text-slate-300"}`}>
              {card.accountTier}
            </span>
          )}
        </div>

        {/* Company link (suppressed when already in company context) */}
        {card.companyName && !hideCompanyLink && (
          <a
            href={card.companyId ? `/companies/${card.companyId}` : undefined}
            className="text-xs font-semibold text-white hover:text-amber-400 transition-colors truncate flex items-center gap-1"
            data-testid={`nba-card-company-link-${card.id}`}
          >
            {card.companyName}
            {card.companyId && <Link2 className="w-2.5 h-2.5 opacity-40" />}
          </a>
        )}

        {/* Why this now — clamped to 2 lines */}
        <p className="text-xs text-white/70 leading-snug line-clamp-2">{card.whyThisNow}</p>

        {/* Signal bullets — max 3, single line each */}
        {bullets.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {bullets.map((sig, i) => (
              <li key={i} className="text-[10px] text-white/40 flex items-start gap-1.5 leading-tight line-clamp-1">
                <span className="mt-1 w-1 h-1 rounded-full bg-white/25 shrink-0" />
                {sig}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Bottom: suggested action + action buttons */}
      <div className="flex flex-col gap-1.5 mt-2">
        {/* Action suggestion — clamped to 1 line */}
        <div className="flex items-center gap-1.5 bg-amber-500/8 rounded px-2 py-1 border border-amber-500/15">
          <ArrowRight className="w-3 h-3 text-amber-400 shrink-0" />
          <p className="text-[11px] text-amber-100/90 line-clamp-1">{card.suggestedAction}</p>
        </div>

        {/* Action row */}
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={handleSnooze}
            disabled={resolveMutation.isPending}
            className="flex items-center gap-1 text-[10px] text-white/30 hover:text-white/55 transition-colors px-1.5 py-1"
            data-testid={`nba-card-snooze-${card.id}`}
          >
            <Clock className="w-3 h-3" />
            Snooze
          </button>
          <button
            onClick={() => setShowDismiss(true)}
            disabled={resolveMutation.isPending}
            className="flex items-center gap-1 text-[10px] text-white/30 hover:text-red-400 transition-colors px-1.5 py-1"
            data-testid={`nba-card-dismiss-btn-${card.id}`}
          >
            <X className="w-3 h-3" />
            Dismiss
          </button>
          <Button
            size="sm"
            onClick={handleAction}
            disabled={resolveMutation.isPending}
            className="h-6 text-[10px] px-2 bg-white/8 hover:bg-white/12 text-white/50 border border-white/15"
            data-testid={`nba-card-action-${card.id}`}
          >
            <CheckCircle2 className="w-3 h-3 mr-0.5" />
            Done
          </Button>
          {card.companyId && (
            <Button
              size="sm"
              onClick={() => setShowLogTouch(true)}
              disabled={resolveMutation.isPending}
              className="h-6 text-[10px] px-2 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/30"
              data-testid={`nba-card-log-touch-${card.id}`}
            >
              <PhoneCall className="w-3 h-3 mr-0.5" />
              Log Touch
            </Button>
          )}
        </div>
      </div>

      {/* Log Touch dialog — only mounted when triggered */}
      {card.companyId && showLogTouch && (
        <NbaLogTouchDialog
          open={showLogTouch}
          onClose={() => setShowLogTouch(false)}
          cardId={card.id}
          companyId={card.companyId}
          companyName={card.companyName ?? ""}
          contactId={card.contactId}
          onActioned={() => {
            onActioned?.(card.id);
            setShowLogTouch(false);
          }}
        />
      )}
    </div>
  );
}
