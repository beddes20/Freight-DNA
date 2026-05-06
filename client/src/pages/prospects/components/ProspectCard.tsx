import { ChevronRight, User, Truck, Target, TrendingUp, Clock, Calendar, CheckCircle2 } from "lucide-react";
import type { ProspectStage } from "@shared/schema";
import { AccountStatusBadge } from "./AccountStatusBadge";
import { PriorityBadge } from "./PriorityBadge";
import { isOverdue, isDueToday, isStale, daysAgo, formatCurrency } from "../utils";
import { STAGE_BORDER } from "../types";
import type { EnrichedProspect } from "../types";

export function ProspectCard({ prospect, onClick, oppSummary, staleThreshold }: {
  prospect: EnrichedProspect;
  onClick: () => void;
  oppSummary?: { openCount: number; closedWonCount: number; pipelineValue: number };
  staleThreshold?: number;
}) {
  const stage = prospect.stage as ProspectStage;
  const overdue = isOverdue(prospect.followUpDate);
  const dueToday = isDueToday(prospect.followUpDate);
  const stale = isStale(prospect, staleThreshold);
  const daysSinceTouch = daysAgo(prospect.updatedAt as unknown as string);

  return (
    <div
      className={`bg-card border border-border border-t-4 ${STAGE_BORDER[stage] ?? "border-t-slate-400"} ${stale ? "border-l-2 border-l-amber-400" : ""} rounded-lg p-3 cursor-pointer hover:shadow-md transition-shadow space-y-2`}
      onClick={onClick}
      data-testid={`prospect-card-${prospect.id}`}
    >
      <div className="flex items-start justify-between gap-1">
        <p className="font-semibold text-sm leading-tight flex-1 min-w-0">{prospect.name}</p>
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <AccountStatusBadge status={prospect.accountStatus} changedAt={prospect.accountStatusChangedAt} />
        <PriorityBadge priority={prospect.priority} />
        {prospect.dealProbability != null && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 font-semibold" data-testid={`prob-badge-${prospect.id}`}>
            {prospect.dealProbability}%
          </span>
        )}
      </div>

      {prospect.primaryContactName && (
        <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
          <User className="h-3 w-3 shrink-0" />
          {prospect.primaryContactName}{prospect.primaryContactTitle ? ` · ${prospect.primaryContactTitle}` : ""}
        </p>
      )}

      {prospect.estimatedSpend && (
        <p className="text-xs text-muted-foreground">~{prospect.estimatedSpend}/mo</p>
      )}

      {oppSummary && (oppSummary.openCount > 0 || oppSummary.closedWonCount > 0) && (
        <div className="flex items-center gap-2 text-[10px]">
          {oppSummary.openCount > 0 && (
            <span className="text-blue-600 dark:text-blue-400 flex items-center gap-0.5" data-testid={`opp-count-${prospect.id}`}>
              <Target className="h-2.5 w-2.5" />{oppSummary.openCount} open
            </span>
          )}
          {oppSummary.pipelineValue > 0 && (
            <span className="text-emerald-600 dark:text-emerald-400 font-semibold" data-testid={`pipeline-value-${prospect.id}`}>
              {formatCurrency(oppSummary.pipelineValue)}/mo
            </span>
          )}
          {oppSummary.closedWonCount > 0 && (
            <span className="text-emerald-700 dark:text-emerald-300 flex items-center gap-0.5">
              <CheckCircle2 className="h-2.5 w-2.5" />{oppSummary.closedWonCount} won
            </span>
          )}
        </div>
      )}

      {prospect.currentCarrier && (
        <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
          <Truck className="h-3 w-3 shrink-0" /> vs {prospect.currentCarrier}
        </p>
      )}

      {prospect.expectedCloseDate && (
        <p className="text-[10px] text-muted-foreground flex items-center gap-0.5" data-testid={`close-date-badge-${prospect.id}`}>
          <TrendingUp className="h-2.5 w-2.5 shrink-0" /> Close: {prospect.expectedCloseDate}
        </p>
      )}

      <div className="flex items-center justify-between pt-0.5 gap-2">
        {stale ? (
          <span className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5" data-testid={`stale-badge-${prospect.id}`}>
            <Clock className="h-2.5 w-2.5" /> {daysSinceTouch}d stale
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">{daysSinceTouch === 0 ? "Updated today" : `${daysSinceTouch}d ago`}</span>
        )}
        {prospect.followUpDate && (
          <span className={`text-[10px] flex items-center gap-0.5 ${overdue ? "text-red-500" : dueToday ? "text-amber-500" : "text-muted-foreground"}`} data-testid={`followup-badge-${prospect.id}`}>
            <Calendar className="h-2.5 w-2.5" />
            {overdue ? "Overdue" : dueToday ? "Due today" : prospect.followUpDate}
          </span>
        )}
      </div>
    </div>
  );
}
