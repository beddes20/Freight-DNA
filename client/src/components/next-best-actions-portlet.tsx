/**
 * NextBestActionsPortlet — dashboard portlet
 *
 * Shows the top accounts that need attention today, based on the NBA engine.
 * Fetches from GET /api/next-best-actions (batch endpoint).
 * Phase 1 change: default-expanded; shows top 3 Critical/High items with
 * "Show all" expand toggle for the rest.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { STALE_15MIN } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChevronDown,
  ChevronUp,
  Zap,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type NbaUrgency = "critical" | "high" | "moderate" | "none";

interface NbaItem {
  ruleId:      string;
  actionName:  string;
  reason:      string;
  urgency:     NbaUrgency;
  owner:       string;
  cta:         string;
  ctaLabel:    string;
  signals: {
    [key: string]: unknown;
  };
  companyId:   string;
  companyName: string;
}

interface NbaBatchResponse {
  items:          NbaItem[];
  totalEvaluated: number;
}

// ── Urgency config ────────────────────────────────────────────────────────────

const URGENCY: Record<
  NbaUrgency,
  { dot: string; badge: string; label: string }
> = {
  critical: {
    dot:   "bg-red-500",
    badge: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800",
    label: "Critical",
  },
  high: {
    dot:   "bg-amber-500",
    badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800",
    label: "High",
  },
  moderate: {
    dot:   "bg-blue-500",
    badge: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border-blue-200 dark:border-blue-800",
    label: "Moderate",
  },
  none: {
    dot:   "bg-muted-foreground",
    badge: "bg-muted text-muted-foreground border-border",
    label: "—",
  },
};

// How many critical/high items to show before the "Show all" button
const PREVIEW_COUNT = 3;

// ── Portlet ──────────────────────────────────────────────────────────────────

interface NextBestActionsPortletProps {
  collapsed: boolean;
  onToggle:  () => void;
  showSystemRecommendationLabel?: boolean;
}

export function NextBestActionsPortlet({ collapsed, onToggle, showSystemRecommendationLabel }: NextBestActionsPortletProps) {
  const [, navigate] = useLocation();
  const [showAll, setShowAll] = useState(false);

  const { data, isLoading, isError } = useQuery<NbaBatchResponse>({
    queryKey: ["/api/next-best-actions"],
    staleTime: STALE_15MIN,
  });

  const items = data?.items ?? [];

  // Separate priority (critical+high) from moderate/none
  const priorityItems = items.filter(i => i.urgency === "critical" || i.urgency === "high");
  const restItems     = items.filter(i => i.urgency !== "critical" && i.urgency !== "high");

  const criticalCount = items.filter(i => i.urgency === "critical").length;
  const highCount     = items.filter(i => i.urgency === "high").length;
  const urgentCount   = criticalCount + highCount;

  // Items visible when not in showAll mode: top 3 priority, none of the rest
  const visiblePriority = showAll ? priorityItems : priorityItems.slice(0, PREVIEW_COUNT);
  const visibleRest     = showAll ? restItems : [];
  const hiddenCount     = (priorityItems.length - visiblePriority.length) + (showAll ? 0 : restItems.length);

  function renderRow(item: NbaItem, idx: number) {
    const u = URGENCY[item.urgency] ?? URGENCY.moderate;
    return (
      <button
        key={`${item.companyId}-${idx}`}
        type="button"
        className="flex items-center gap-3 py-2.5 text-left w-full hover:bg-muted/50 rounded px-1 -mx-1 transition-colors group"
        onClick={() => navigate(`/companies/${item.companyId}`)}
        data-testid={`nba-row-${item.companyId}`}
      >
        <span className={`shrink-0 h-2 w-2 rounded-full ${u.dot}`} aria-label={u.label} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold truncate leading-tight">{item.companyName}</p>
          <p className="text-[10px] text-muted-foreground truncate leading-tight mt-0.5">{item.actionName}</p>
        </div>
        <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded border ${u.badge}`}>
          {u.label}
        </span>
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
      </button>
    );
  }

  return (
    <Card data-testid="portlet-next-best-actions">
      {/* ── Header / toggle ── */}
      <button
        type="button"
        className="w-full cursor-pointer select-none flex flex-row items-center justify-between py-3 px-4"
        onClick={onToggle}
        aria-expanded={!collapsed}
        data-testid="button-toggle-nba-portlet"
      >
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-semibold">
            {showSystemRecommendationLabel ? "System Recommendation" : "Do This First"}
          </span>
          {!isLoading && !isError && (
            <div className="flex items-center gap-1.5">
              {criticalCount > 0 && (
                <Badge variant="destructive" className="text-xs px-1.5" data-testid="badge-nba-critical-count">
                  {criticalCount} critical
                </Badge>
              )}
              {highCount > 0 && (
                <Badge className="text-xs px-1.5 bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-0" data-testid="badge-nba-high-count">
                  {highCount} high
                </Badge>
              )}
              {urgentCount === 0 && items.length > 0 && (
                <Badge className="text-xs px-1.5 bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border-0" data-testid="badge-nba-moderate-count">
                  {items.length} moderate
                </Badge>
              )}
            </div>
          )}
        </div>
        {collapsed
          ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
          : <ChevronUp   className="h-4 w-4 text-muted-foreground" />}
      </button>

      {/* ── Body ── */}
      {!collapsed && (
        <CardContent className="pt-0 px-4 pb-4">

          {isLoading && (
            <div className="flex flex-col gap-2" data-testid="nba-portlet-loading">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          )}

          {isError && !isLoading && (
            <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground" data-testid="nba-portlet-error">
              <AlertTriangle className="h-8 w-8 opacity-30" />
              <p className="text-sm text-center">Unable to load priority actions. Try refreshing.</p>
            </div>
          )}

          {!isLoading && !isError && items.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground" data-testid="nba-portlet-empty">
              <CheckCircle2 className="h-8 w-8 opacity-30" />
              <p className="text-sm text-center">All accounts are in good standing — no priority actions needed.</p>
            </div>
          )}

          {!isLoading && !isError && items.length > 0 && (
            <div className="flex flex-col divide-y" data-testid="nba-portlet-list">
              {/* Priority items (critical + high) */}
              {visiblePriority.map((item, idx) => renderRow(item, idx))}

              {/* Moderate/none items — only shown when expanded */}
              {visibleRest.map((item, idx) => renderRow(item, priorityItems.length + idx))}

              {/* Show all / collapse toggle */}
              {(hiddenCount > 0 || showAll) && (
                <div className="pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs w-full"
                    onClick={(e) => { e.stopPropagation(); setShowAll(v => !v); }}
                    data-testid="button-nba-show-all"
                  >
                    {showAll
                      ? "Show fewer"
                      : `Show ${hiddenCount} more action${hiddenCount !== 1 ? "s" : ""}`}
                  </Button>
                </div>
              )}
            </div>
          )}

        </CardContent>
      )}
    </Card>
  );
}
