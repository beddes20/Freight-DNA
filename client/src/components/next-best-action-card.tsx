/**
 * NextBestActionCard
 *
 * Renders the single per-account recommendation from the NBA engine.
 * Self-fetching via GET /api/companies/:id/next-best-action.
 *
 * Designed to sit at the top of the Overview tab in company-detail.
 * Can also be reused in the dashboard portlet and pre-call planner
 * by passing the relevant callbacks.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChevronDown,
  ChevronUp,
  Zap,
  AlertTriangle,
  TrendingDown,
  Clock,
  Users,
  FileText,
  Route,
  CheckCircle2,
  Crown,
} from "lucide-react";

// ── Types (mirror the server types; no shared import needed here) ─────────────

type NbaUrgency = "critical" | "high" | "moderate" | "none";
type NbaCta =
  | "log_touch"
  | "create_task"
  | "compose_email"
  | "schedule_meeting"
  | "view_rfp"
  | "none";

interface NbaSignals {
  currentScore:            number | null;
  currentBand:             string | null;
  previousScore:           number | null;
  previousBand:            string | null;
  scoreDrop:               number | null;
  daysSinceLastTouch:      number | null;
  touchesLast30d:          number;
  meaningfulConvosLast60d: number;
  contactCount:            number;
  contactsWithBase:        number;
  laneCorridorCount:       number;
  openRfpCount:            number;
  urgentRfpDaysUntilDue:   number | null;
  urgentRfpTitle:          string | null;
  totalLoadsYtd:           number | null;
  overdueTaskCount:        number;
}

interface NextBestAction {
  ruleId:          string;
  actionName:      string;
  reason:          string;
  urgency:         NbaUrgency;
  owner:           string;
  expectedOutcome: string;
  cta:             NbaCta;
  ctaLabel:        string;
  rfpId?:          string;
  signals:         NbaSignals;
}

// ── Urgency config ────────────────────────────────────────────────────────────

const URGENCY_CONFIG: Record<
  NbaUrgency,
  { label: string; badgeCls: string; borderCls: string; iconCls: string }
> = {
  critical: {
    label:     "Critical",
    badgeCls:  "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800/50",
    borderCls: "border-l-4 border-l-red-500",
    iconCls:   "text-red-500",
  },
  high: {
    label:     "High Priority",
    badgeCls:  "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800/50",
    borderCls: "border-l-4 border-l-amber-500",
    iconCls:   "text-amber-500",
  },
  moderate: {
    label:     "Recommended",
    badgeCls:  "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border-blue-200 dark:border-blue-800/50",
    borderCls: "border-l-4 border-l-blue-500",
    iconCls:   "text-blue-500",
  },
  none: {
    label:     "No Action Needed",
    badgeCls:  "bg-muted text-muted-foreground border-border",
    borderCls: "border-l-4 border-l-muted",
    iconCls:   "text-muted-foreground",
  },
};

// ── Signal chips shown in the "Why now?" section ──────────────────────────────

function buildSignalChips(signals: NbaSignals): Array<{ icon: JSX.Element; text: string }> {
  const chips: Array<{ icon: JSX.Element; text: string }> = [];

  if (signals.daysSinceLastTouch === null) {
    chips.push({ icon: <Clock className="h-3 w-3" />, text: "Never contacted" });
  } else if (signals.daysSinceLastTouch > 0) {
    chips.push({ icon: <Clock className="h-3 w-3" />, text: `Last touch ${signals.daysSinceLastTouch}d ago` });
  }

  if (signals.scoreDrop !== null && signals.scoreDrop >= 10) {
    chips.push({ icon: <TrendingDown className="h-3 w-3" />, text: `Score dropped ${signals.scoreDrop} pts` });
  }

  if (signals.currentBand) {
    const bandLabels: Record<string, string> = {
      at_risk:        "At Risk",
      stable:         "Stable",
      growth_ready:   "Growth Ready",
      high_expansion: "High Expansion",
    };
    chips.push({ icon: <Zap className="h-3 w-3" />, text: `Band: ${bandLabels[signals.currentBand] ?? signals.currentBand}` });
  }

  if (signals.contactsWithBase < 2 && signals.contactCount > 0) {
    chips.push({ icon: <Users className="h-3 w-3" />, text: `${signals.contactsWithBase} mapped contact${signals.contactsWithBase === 1 ? "" : "s"}` });
  }

  if (signals.urgentRfpTitle && signals.urgentRfpDaysUntilDue !== null) {
    chips.push({ icon: <FileText className="h-3 w-3" />, text: `"${signals.urgentRfpTitle}" due in ${signals.urgentRfpDaysUntilDue}d` });
  }

  if (signals.laneCorridorCount < 3) {
    chips.push({ icon: <Route className="h-3 w-3" />, text: `${signals.laneCorridorCount} lane${signals.laneCorridorCount === 1 ? "" : "s"} attributed` });
  }

  if (signals.touchesLast30d > 0) {
    chips.push({ icon: <CheckCircle2 className="h-3 w-3" />, text: `${signals.touchesLast30d} touch${signals.touchesLast30d === 1 ? "" : "es"} in last 30d` });
  }

  // Cap to 4 most relevant chips
  return chips.slice(0, 4);
}

// ── Main component ─────────────────────────────────────────────────────────────

interface NextBestActionCardProps {
  companyId:            string;
  onLogTouch?:          () => void;
  onCreateTask?:        () => void;
  onViewRfp?:           () => void;
  onAssignForcedFocus?: () => void;
}

export function NextBestActionCard({
  companyId,
  onLogTouch,
  onCreateTask,
  onViewRfp,
  onAssignForcedFocus,
}: NextBestActionCardProps) {
  const [whyOpen, setWhyOpen] = useState(false);

  const { data, isLoading, isError } = useQuery<NextBestAction>({
    queryKey: ["/api/companies", companyId, "next-best-action"],
  });

  // ── Loading state ──────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <Card data-testid="card-nba-loading">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-5 rounded" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-20 rounded-full ml-auto" />
          </div>
        </CardHeader>
        <CardContent className="space-y-2 pt-0">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-8 w-28 mt-3" />
        </CardContent>
      </Card>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (isError || !data) {
    return (
      <Card className="border-l-4 border-l-muted" data-testid="card-nba-error">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2 text-muted-foreground">
            <AlertTriangle className="h-4 w-4" />
            Next Best Action
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">
            Unable to load recommendation right now. Try refreshing the page.
          </p>
        </CardContent>
      </Card>
    );
  }

  const cfg = URGENCY_CONFIG[data.urgency];

  // ── No-action state (R13) ──────────────────────────────────────────────────
  if (data.urgency === "none") {
    return (
      <Card className={cfg.borderCls} data-testid="card-nba-no-action">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CheckCircle2 className={`h-4 w-4 ${cfg.iconCls}`} />
            Next Best Action
            <Badge variant="outline" className={`ml-auto text-xs ${cfg.badgeCls}`} data-testid="badge-nba-urgency">
              {cfg.label}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">{data.reason}</p>
        </CardContent>
      </Card>
    );
  }

  // ── Active recommendation ─────────────────────────────────────────────────
  const chips = buildSignalChips(data.signals);

  const handleCta = () => {
    switch (data.cta) {
      case "log_touch":     onLogTouch?.();   break;
      case "create_task":   onCreateTask?.(); break;
      case "schedule_meeting": onCreateTask?.(); break;
      case "view_rfp":      onViewRfp?.();    break;
      case "compose_email": onLogTouch?.();   break; // fallback: log a touch instead
      default:              break;
    }
  };

  return (
    <Card className={cfg.borderCls} data-testid="card-nba">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Zap className={`h-4 w-4 ${cfg.iconCls}`} />
          Next Best Action
          <Badge
            variant="outline"
            className={`ml-auto text-xs ${cfg.badgeCls}`}
            data-testid="badge-nba-urgency"
          >
            {cfg.label}
          </Badge>
        </CardTitle>
      </CardHeader>

      <CardContent className="pt-0 space-y-3">
        {/* Action name + reason */}
        <div>
          <p className="text-sm font-semibold leading-snug" data-testid="text-nba-action-name">
            {data.actionName}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed" data-testid="text-nba-reason">
            {data.reason}
          </p>
        </div>

        {/* Expected outcome */}
        <div className="rounded-md bg-muted/50 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">
            Expected outcome
          </p>
          <p className="text-xs text-foreground/80" data-testid="text-nba-outcome">
            {data.expectedOutcome}
          </p>
        </div>

        {/* CTA button */}
        <div className="flex gap-2">
          {data.cta !== "none" && (
            <Button
              size="sm"
              variant="default"
              className="flex-1"
              onClick={handleCta}
              data-testid="button-nba-cta"
            >
              {data.ctaLabel}
            </Button>
          )}
          {onAssignForcedFocus && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 border-purple-400/40 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950/30 shrink-0"
              onClick={onAssignForcedFocus}
              data-testid="button-nba-assign-priority"
            >
              <Crown className="h-3.5 w-3.5" />
              Assign Priority
            </Button>
          )}
        </div>

        {/* "Why now?" expandable signals section */}
        {chips.length > 0 && (
          <div>
            <button
              type="button"
              className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setWhyOpen(v => !v)}
              data-testid="button-nba-why-toggle"
            >
              {whyOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              Why now?
            </button>

            {whyOpen && (
              <div className="mt-2 flex flex-wrap gap-1.5" data-testid="section-nba-signals">
                {chips.map((chip, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                  >
                    {chip.icon}
                    {chip.text}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
