import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Link, useLocation } from "wouter";
import { TaskDialog } from "@/components/task-dialog";
import {
  Truck, MapPin, Flame, Package, TrendingUp, Building2,
  FileText, Zap, Plus, ExternalLink,
} from "lucide-react";

type OpportunityMatch = {
  companyId: string;
  companyName: string;
  rfpId: string;
  rfpTitle: string;
  lane: string;
  volume: number;
  rate: number;
  equipment: string;
};

type Opportunity = {
  destination: string;
  city: string;
  state: string;
  weeklyLoadCount: number;
  maxWeekly: number;
  matches: OpportunityMatch[];
};

type TaskPrefill = {
  companyId: string;
  title: string;
  notes: string;
};

export default function TopOpportunities() {
  const [, navigate] = useLocation();
  const { data: opportunities, isLoading } = useQuery<Opportunity[]>({
    queryKey: ["/api/opportunities"],
  });

  const [taskOpen, setTaskOpen] = useState(false);
  const [taskPrefill, setTaskPrefill] = useState<TaskPrefill | null>(null);

  const openTask = (opp: Opportunity, match: OpportunityMatch) => {
    setTaskPrefill({
      companyId: match.companyId,
      title: `Pursue opportunity: ${opp.destination} — ${match.lane}`,
      notes: `Opportunity Zone: ${opp.destination}\nWe deliver here ~${opp.weeklyLoadCount} loads/week avg (peak ${opp.maxWeekly}/week)\n\nRFP: ${match.rfpTitle}\nLane: ${match.lane}${match.volume ? `\nVolume: ${match.volume} loads` : ""}${match.equipment ? `\nEquipment: ${match.equipment}` : ""}`,
    });
    setTaskOpen(true);
  };

  const goToAccount = (match: OpportunityMatch) => {
    navigate(`/companies/${match.companyId}?rfpTab=matching`);
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Zap className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Top Opportunities</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          Destinations where we regularly deliver trucks, matched against RFP lane origins — natural repositioning opportunities.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardHeader><Skeleton className="h-5 w-48" /></CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !opportunities || opportunities.length === 0 ? (
        <Card>
          <CardContent className="py-20 text-center">
            <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="font-semibold text-lg text-muted-foreground">No opportunities found</p>
            <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
              Opportunities appear when historical data has destinations with 5+ loads in any week AND
              matching RFP lane origins exist. Upload dispatch data and add RFPs with lane data to get started.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4" data-testid="opportunities-list">
          {opportunities.map((opp, idx) => (
            <Card key={opp.destination} data-testid={`card-opportunity-${idx}`} className="overflow-hidden">
              <CardHeader className="pb-3 bg-gradient-to-r from-primary/5 to-transparent border-b">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center h-8 w-8 rounded-full bg-primary/10 text-primary font-bold text-sm shrink-0">
                      {idx + 1}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <MapPin className="h-4 w-4 text-primary" />
                        <span className="font-semibold text-base" data-testid={`text-destination-${idx}`}>
                          {opp.city}, {opp.state}
                        </span>
                        {opp.maxWeekly >= 5 && (
                          <Badge className="bg-orange-500/10 text-orange-600 dark:text-orange-400 border-0 text-xs">
                            <Flame className="h-3 w-3 mr-1" /> Hot Zone
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        We deliver here{" "}
                        <span className="font-medium text-foreground" data-testid={`text-weekly-count-${idx}`}>
                          ~{opp.weeklyLoadCount} loads/week avg
                        </span>
                        {" "}· peak {opp.maxWeekly}/week
                      </p>
                    </div>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-xs">
                    <Truck className="h-3 w-3 mr-1" />
                    {opp.matches.length} {opp.matches.length === 1 ? "match" : "matches"}
                  </Badge>
                </div>
              </CardHeader>

              <CardContent className="p-0">
                <div className="divide-y">
                  {opp.matches.map((match, mIdx) => (
                    <div
                      key={`${match.rfpId}-${mIdx}`}
                      data-testid={`row-match-${idx}-${mIdx}`}
                      className="px-4 py-3 hover:bg-muted/40 transition-colors group"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 min-w-0">
                          <Building2 className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span
                                className="font-medium text-sm text-primary hover:underline cursor-pointer"
                                data-testid={`text-company-${idx}-${mIdx}`}
                                onClick={() => goToAccount(match)}
                              >
                                {match.companyName}
                              </span>
                              <span className="text-muted-foreground text-xs">·</span>
                              <span className="text-xs text-muted-foreground flex items-center gap-1">
                                <FileText className="h-3 w-3" />
                                {match.rfpTitle}
                              </span>
                            </div>
                            <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                              <span className="font-medium text-foreground">{match.lane}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                          {match.volume > 0 && (
                            <Badge variant="secondary" className="text-xs">
                              <TrendingUp className="h-3 w-3 mr-1" />
                              {match.volume} loads
                            </Badge>
                          )}
                          {match.equipment && (
                            <Badge variant="outline" className="text-xs">
                              {match.equipment}
                            </Badge>
                          )}
                          {match.rate > 0 && (
                            <Badge variant="outline" className="text-xs font-mono">
                              ${Number(match.rate).toLocaleString()}
                            </Badge>
                          )}
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs gap-1"
                              onClick={() => goToAccount(match)}
                              data-testid={`btn-view-account-${idx}-${mIdx}`}
                              title="View on account page"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Account
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs gap-1 text-primary border-primary/30 hover:bg-primary/5"
                              onClick={() => openTask(opp, match)}
                              data-testid={`btn-add-task-${idx}-${mIdx}`}
                              title="Create a task for this opportunity"
                            >
                              <Plus className="h-3 w-3" />
                              Task
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {taskPrefill && (
        <TaskDialog
          open={taskOpen}
          onOpenChange={(open) => {
            setTaskOpen(open);
            if (!open) setTaskPrefill(null);
          }}
          companyId={taskPrefill.companyId}
          prefillData={{
            title: taskPrefill.title,
            notes: taskPrefill.notes,
          }}
        />
      )}
    </div>
  );
}
