import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { useLocation } from "wouter";
import { TaskDialog } from "@/components/task-dialog";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Truck, MapPin, Flame, Package, TrendingUp, Building2,
  FileText, Zap, Plus, ExternalLink, Trash2, RotateCcw, EyeOff, ChevronDown,
  Users, Briefcase, DollarSign, Calendar, BarChart2, StickyNote, ChevronRight,
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

type CompanyGroup = {
  companyId: string;
  companyName: string;
  totalMatches: number;
  hotZoneCount: number;
  matches: Array<{
    destination: string;
    city: string;
    state: string;
    weeklyLoadCount: number;
    maxWeekly: number;
    rfpId: string;
    rfpTitle: string;
    lane: string;
    volume: number;
    rate: number;
    equipment: string;
  }>;
};

type TaskPrefill = {
  companyId: string;
  title: string;
  notes: string;
};

type Dismissal = { company_id: string; company_name: string; dismissed_at: string };

type FieldCreatedOpportunity = {
  id: number;
  name: string;
  record_type: string;
  stage: string;
  outcome: string | null;
  amount: string | null;
  close_date: string | null;
  probability: number | null;
  notes: string | null;
  lost_reason: string | null;
  created_at: string | null;
  company_id: string | null;
  prospect_id: number | null;
  company_name: string;
};

type FieldCreatedCompanyGroup = {
  companyId: string | null;
  companyName: string;
  opportunities: FieldCreatedOpportunity[];
};

const RECORD_TYPE_LABELS: Record<string, string> = {
  single_multi_lane: "Single/Multi-Lane",
  private_hauling: "Private Hauling",
  trucking_opportunity: "Trucking Opportunity",
};

const STAGE_LABELS: Record<string, string> = {
  qualification: "Qualification",
  proposal: "Proposal",
  negotiation: "Negotiation",
  closed_won: "Closed Won",
  closed_lost: "Closed Lost",
};

const STAGE_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  qualification: "outline",
  proposal: "secondary",
  negotiation: "default",
  closed_won: "default",
  closed_lost: "destructive",
};

function getRecordTypeLabel(rt: string) {
  return RECORD_TYPE_LABELS[rt] ?? rt.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function getStageLabel(stage: string) {
  return STAGE_LABELS[stage] ?? stage.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

type ViewMode = "rfp" | "field";

export default function TopOpportunities() {
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();
  const canManage = ["admin", "director", "national_account_manager", "sales_director"].includes(user?.role || "");

  const [viewMode, setViewMode] = useState<ViewMode>("rfp");

  const { data: opportunities, isLoading } = useQuery<Opportunity[]>({
    queryKey: ["/api/opportunities"],
  });

  const { data: dismissals = [] } = useQuery<Dismissal[]>({
    queryKey: ["/api/opportunities/dismissals"],
    enabled: canManage,
  });

  const { data: fieldOpportunities = [], isLoading: isFieldLoading } = useQuery<FieldCreatedOpportunity[]>({
    queryKey: ["/api/opportunities/field-created"],
  });

  const [confirmDismiss, setConfirmDismiss] = useState<{ companyId: string; companyName: string } | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskPrefill, setTaskPrefill] = useState<TaskPrefill | null>(null);
  const [expandedCompanies, setExpandedCompanies] = useState<Record<string, boolean>>({});
  const [selectedFieldOpp, setSelectedFieldOpp] = useState<FieldCreatedOpportunity | null>(null);

  const toggleCollapsed = (companyId: string) => {
    setExpandedCompanies(prev => ({ ...prev, [companyId]: !prev[companyId] }));
  };

  const dismissMutation = useMutation({
    mutationFn: (companyId: string) => apiRequest("POST", `/api/opportunities/dismiss/${companyId}`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/opportunities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/opportunities/dismissals"] });
      toast({ title: "Opportunity removed", description: "It won't appear in the list. You can restore it below." });
      setConfirmDismiss(null);
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (companyId: string) => apiRequest("DELETE", `/api/opportunities/dismiss/${companyId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/opportunities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/opportunities/dismissals"] });
      toast({ title: "Opportunity restored" });
    },
  });

  const byCompany = useMemo<CompanyGroup[]>(() => {
    if (!opportunities) return [];
    const map = new Map<string, CompanyGroup>();
    opportunities.forEach(opp => {
      opp.matches.forEach(match => {
        if (!map.has(match.companyId)) {
          map.set(match.companyId, {
            companyId: match.companyId,
            companyName: match.companyName,
            totalMatches: 0,
            hotZoneCount: 0,
            matches: [],
          });
        }
        const group = map.get(match.companyId)!;
        group.matches.push({
          destination: opp.destination,
          city: opp.city,
          state: opp.state,
          weeklyLoadCount: opp.weeklyLoadCount,
          maxWeekly: opp.maxWeekly,
          rfpId: match.rfpId,
          rfpTitle: match.rfpTitle,
          lane: match.lane,
          volume: match.volume,
          rate: match.rate,
          equipment: match.equipment,
        });
        group.totalMatches += 1;
        if (opp.maxWeekly >= 5) group.hotZoneCount += 1;
      });
    });
    return Array.from(map.values()).sort((a, b) => b.hotZoneCount - a.hotZoneCount || b.totalMatches - a.totalMatches);
  }, [opportunities]);

  const fieldByCompany = useMemo<FieldCreatedCompanyGroup[]>(() => {
    const map = new Map<string, FieldCreatedCompanyGroup>();
    fieldOpportunities.forEach(opp => {
      const key = opp.company_id ?? `__no_company__${opp.company_name}`;
      if (!map.has(key)) {
        map.set(key, {
          companyId: opp.company_id,
          companyName: opp.company_name || "Unknown Company",
          opportunities: [],
        });
      }
      map.get(key)!.opportunities.push(opp);
    });
    return Array.from(map.values()).sort((a, b) => a.companyName.localeCompare(b.companyName));
  }, [fieldOpportunities]);

  const openTask = (group: CompanyGroup, match: CompanyGroup["matches"][number]) => {
    setTaskPrefill({
      companyId: group.companyId,
      title: `Pursue opportunity: ${match.destination} — ${match.lane}`,
      notes: `Opportunity Zone: ${match.destination}\nWe deliver here ~${match.weeklyLoadCount} loads/week avg (peak ${match.maxWeekly}/week)\n\nRFP: ${match.rfpTitle}\nLane: ${match.lane}${match.volume ? `\nVolume: ${match.volume} loads` : ""}${match.equipment ? `\nEquipment: ${match.equipment}` : ""}`,
    });
    setTaskOpen(true);
  };

  const goToAccount = (companyId: string) => {
    navigate(`/companies/${companyId}?rfpTab=matching`);
  };

  const handleViewChange = (mode: ViewMode) => {
    setViewMode(mode);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Zap className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Top Opportunities</h1>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          {viewMode === "rfp"
            ? "Accounts with RFP lanes that overlap our delivery zones — grouped by customer for easy follow-up."
            : "Manually entered CRM opportunities from your field sales team."}
        </p>
      </div>

      {/* Pill toggle */}
      <div
        className="inline-flex items-center rounded-full border bg-muted p-1 gap-1"
        data-testid="toggle-view-mode"
      >
        <button
          type="button"
          onClick={() => handleViewChange("rfp")}
          data-testid="btn-toggle-rfp"
          className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
            viewMode === "rfp"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <FileText className="h-3.5 w-3.5" />
          RFP / Mini-Bid Matches
        </button>
        <button
          type="button"
          onClick={() => handleViewChange("field")}
          data-testid="btn-toggle-field"
          className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
            viewMode === "field"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Users className="h-3.5 w-3.5" />
          Field-Created Opportunities
        </button>
      </div>

      {/* RFP / Mini-Bid Matches View */}
      {viewMode === "rfp" && (
        <>
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
          ) : !byCompany || byCompany.length === 0 ? (
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
              {byCompany.map((group, idx) => (
                <Card key={group.companyId} data-testid={`card-opportunity-company-${group.companyId}`} className="overflow-hidden">
                  <CardHeader
                    className="pb-3 bg-gradient-to-r from-primary/5 to-transparent border-b cursor-pointer select-none"
                    onClick={() => toggleCollapsed(group.companyId)}
                    data-testid={`btn-toggle-company-${group.companyId}`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center justify-center h-8 w-8 rounded-full bg-primary/10 text-primary font-bold text-sm shrink-0">
                          {idx + 1}
                        </div>
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <Building2 className="h-4 w-4 text-primary" />
                            <span
                              className="font-semibold text-base text-primary hover:underline cursor-pointer"
                              data-testid={`text-company-name-${group.companyId}`}
                              onClick={(e) => { e.stopPropagation(); goToAccount(group.companyId); }}
                            >
                              {group.companyName}
                            </span>
                            {group.hotZoneCount > 0 && (
                              <Badge className="bg-orange-500/10 text-orange-600 dark:text-orange-400 border-0 text-xs">
                                <Flame className="h-3 w-3 mr-1" /> {group.hotZoneCount} hot zone{group.hotZoneCount !== 1 ? "s" : ""}
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {group.totalMatches} delivery zone{group.totalMatches !== 1 ? "s" : ""} match their RFP lanes
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs gap-1"
                          onClick={(e) => { e.stopPropagation(); goToAccount(group.companyId); }}
                          data-testid={`btn-view-account-${group.companyId}`}
                        >
                          <ExternalLink className="h-3 w-3" />
                          Account
                        </Button>
                        <Badge variant="outline" className="text-xs">
                          <Truck className="h-3 w-3 mr-1" />
                          {group.totalMatches} match{group.totalMatches !== 1 ? "es" : ""}
                        </Badge>
                        {canManage && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            onClick={(e) => { e.stopPropagation(); setConfirmDismiss({ companyId: group.companyId, companyName: group.companyName }); }}
                            data-testid={`btn-dismiss-opportunity-${group.companyId}`}
                            title="Remove from list"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <ChevronDown
                          className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${expandedCompanies[group.companyId] ? "" : "-rotate-90"}`}
                          data-testid={`icon-chevron-${group.companyId}`}
                        />
                      </div>
                    </div>
                  </CardHeader>

                  {expandedCompanies[group.companyId] && (
                  <CardContent className="p-0">
                    <div className="divide-y">
                      {group.matches.map((match, mIdx) => (
                        <div
                          key={`${match.rfpId}-${match.destination}-${mIdx}`}
                          data-testid={`row-match-${group.companyId}-${mIdx}`}
                          className="px-4 py-3 hover:bg-muted/40 transition-colors group cursor-pointer"
                          onClick={() => navigate(`/companies/${group.companyId}?tab=rfp`)}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-start gap-3 min-w-0">
                              <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-medium text-sm" data-testid={`text-destination-${group.companyId}-${mIdx}`}>
                                    {match.city}, {match.state}
                                  </span>
                                  {match.maxWeekly >= 5 && (
                                    <Badge className="bg-orange-500/10 text-orange-600 dark:text-orange-400 border-0 text-xs">
                                      <Flame className="h-3 w-3 mr-1" /> Hot Zone
                                    </Badge>
                                  )}
                                  <span className="text-muted-foreground text-xs">·</span>
                                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                                    <FileText className="h-3 w-3" />
                                    {match.rfpTitle}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1 mt-0.5">
                                  <Building2 className="h-3 w-3 text-primary/60 shrink-0" />
                                  <span
                                    className="text-xs text-primary/80 font-medium"
                                    data-testid={`text-match-company-${group.companyId}-${mIdx}`}
                                  >
                                    {group.companyName}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                                  <span className="font-medium text-foreground">{match.lane}</span>
                                  <span className="text-muted-foreground/50 mx-1">·</span>
                                  <span>~{match.weeklyLoadCount}/wk avg · peak {match.maxWeekly}/wk</span>
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
                              <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs gap-1 text-primary border-primary/30 hover:bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity"
                                  onClick={() => openTask(group, match)}
                                  data-testid={`btn-add-task-${group.companyId}-${mIdx}`}
                                  title="Create a task for this opportunity"
                                >
                                  <Plus className="h-3 w-3" />
                                  Task
                                </Button>
                              </div>
                              <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                  )}
                </Card>
              ))}
            </div>
          )}

          {/* Dismissed companies section */}
          {canManage && dismissals.length > 0 && (
            <div className="border rounded-lg p-4 bg-muted/30 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <EyeOff className="h-4 w-4" />
                Removed from list ({dismissals.length})
              </div>
              <div className="space-y-1">
                {dismissals.map(d => (
                  <div key={d.company_id} className="flex items-center justify-between gap-2 text-sm py-1 border-b last:border-0" data-testid={`row-dismissed-${d.company_id}`}>
                    <span className="text-muted-foreground">{d.company_name || d.company_id}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs gap-1 text-primary hover:text-primary hover:bg-primary/10"
                      onClick={() => restoreMutation.mutate(d.company_id)}
                      disabled={restoreMutation.isPending}
                      data-testid={`btn-restore-opportunity-${d.company_id}`}
                    >
                      <RotateCcw className="h-3 w-3" />
                      Restore
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Field-Created Opportunities View */}
      {viewMode === "field" && (
        <>
          {isFieldLoading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <Card key={i}>
                  <CardHeader><Skeleton className="h-5 w-48" /></CardHeader>
                  <CardContent className="space-y-2">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : fieldByCompany.length === 0 ? (
            <Card>
              <CardContent className="py-20 text-center" data-testid="field-empty-state">
                <Briefcase className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <p className="font-semibold text-lg text-muted-foreground">No field-created opportunities</p>
                <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
                  Field-created opportunities appear here once your team adds Single/Multi-Lane, Private Hauling,
                  or Trucking Opportunity records to company accounts in the CRM.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4" data-testid="field-opportunities-list">
              {fieldByCompany.map((group) => (
                <Card key={group.companyId ?? group.companyName} data-testid={`card-field-company-${group.companyId ?? group.companyName}`} className="overflow-hidden">
                  <CardHeader className="pb-3 bg-gradient-to-r from-primary/5 to-transparent border-b">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-primary" />
                        <span
                          className={`font-semibold text-base text-primary ${group.companyId ? "hover:underline cursor-pointer" : ""}`}
                          data-testid={`text-field-company-name-${group.companyId ?? group.companyName}`}
                          onClick={() => group.companyId ? goToAccount(group.companyId) : undefined}
                        >
                          {group.companyName}
                        </span>
                        <Badge variant="outline" className="text-xs">
                          {group.opportunities.length} opportunit{group.opportunities.length !== 1 ? "ies" : "y"}
                        </Badge>
                      </div>
                      {group.companyId && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs gap-1 shrink-0"
                          onClick={() => goToAccount(group.companyId!)}
                          data-testid={`btn-field-view-account-${group.companyId}`}
                        >
                          <ExternalLink className="h-3 w-3" />
                          Account
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="divide-y">
                      {group.opportunities.map((opp) => (
                        <div
                          key={opp.id}
                          data-testid={`row-field-opportunity-${opp.id}`}
                          className="px-4 py-3 hover:bg-muted/40 transition-colors cursor-pointer group"
                          onClick={() => setSelectedFieldOpp(opp)}
                        >
                          <div className="flex items-center justify-between gap-3 flex-wrap">
                            <div className="flex items-center gap-2 min-w-0">
                              <Briefcase className="h-4 w-4 text-muted-foreground shrink-0" />
                              <span
                                className="font-medium text-sm"
                                data-testid={`text-field-opp-name-${opp.id}`}
                              >
                                {opp.name}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge
                                variant="secondary"
                                className="text-xs"
                                data-testid={`badge-record-type-${opp.id}`}
                              >
                                {getRecordTypeLabel(opp.record_type)}
                              </Badge>
                              <Badge
                                variant={STAGE_VARIANT[opp.stage] ?? "outline"}
                                className="text-xs"
                                data-testid={`badge-stage-${opp.id}`}
                              >
                                {getStageLabel(opp.stage)}
                              </Badge>
                              <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
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
        </>
      )}

      {/* Field-Created Opportunity Detail Sheet */}
      <Sheet open={!!selectedFieldOpp} onOpenChange={(open) => { if (!open) setSelectedFieldOpp(null); }}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto" data-testid="sheet-field-opp-detail">
          {selectedFieldOpp && (
            <>
              <SheetHeader className="mb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Briefcase className="h-5 w-5 text-primary" />
                  <Badge variant="secondary" className="text-xs">{getRecordTypeLabel(selectedFieldOpp.record_type)}</Badge>
                  <Badge variant={STAGE_VARIANT[selectedFieldOpp.stage] ?? "outline"} className="text-xs">{getStageLabel(selectedFieldOpp.stage)}</Badge>
                </div>
                <SheetTitle className="text-lg leading-tight" data-testid="text-sheet-opp-name">{selectedFieldOpp.name}</SheetTitle>
                {selectedFieldOpp.company_name && (
                  <SheetDescription className="flex items-center gap-1 mt-1">
                    <Building2 className="h-3.5 w-3.5" />
                    {selectedFieldOpp.company_name}
                  </SheetDescription>
                )}
              </SheetHeader>

              <Separator className="mb-4" />

              <div className="space-y-4">
                {/* Financial details */}
                {(selectedFieldOpp.amount || selectedFieldOpp.close_date || selectedFieldOpp.probability != null) && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Details</p>
                    <div className="grid grid-cols-2 gap-3">
                      {selectedFieldOpp.amount && (
                        <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2">
                          <DollarSign className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                          <div>
                            <p className="text-xs text-muted-foreground">Amount</p>
                            <p className="text-sm font-semibold" data-testid="text-sheet-amount">{selectedFieldOpp.amount}</p>
                          </div>
                        </div>
                      )}
                      {selectedFieldOpp.close_date && (
                        <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2">
                          <Calendar className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
                          <div>
                            <p className="text-xs text-muted-foreground">Close Date</p>
                            <p className="text-sm font-semibold" data-testid="text-sheet-close-date">{selectedFieldOpp.close_date}</p>
                          </div>
                        </div>
                      )}
                      {selectedFieldOpp.probability != null && (
                        <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2">
                          <BarChart2 className="h-4 w-4 text-purple-500 mt-0.5 shrink-0" />
                          <div>
                            <p className="text-xs text-muted-foreground">Probability</p>
                            <p className="text-sm font-semibold" data-testid="text-sheet-probability">{selectedFieldOpp.probability}%</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Notes */}
                {selectedFieldOpp.notes && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                      <StickyNote className="h-3.5 w-3.5" /> Notes
                    </p>
                    <p className="text-sm text-foreground/80 bg-muted/30 rounded-md px-3 py-2 whitespace-pre-wrap" data-testid="text-sheet-notes">{selectedFieldOpp.notes}</p>
                  </div>
                )}

                {/* Lost reason */}
                {selectedFieldOpp.lost_reason && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lost Reason</p>
                    <p className="text-sm text-foreground/80 bg-muted/30 rounded-md px-3 py-2" data-testid="text-sheet-lost-reason">{selectedFieldOpp.lost_reason}</p>
                  </div>
                )}

                {/* Created date */}
                {selectedFieldOpp.created_at && (
                  <p className="text-xs text-muted-foreground">
                    Created {new Date(selectedFieldOpp.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </p>
                )}
              </div>

              {/* Go to Account button */}
              {selectedFieldOpp.company_id && (
                <>
                  <Separator className="my-4" />
                  <Button
                    className="w-full gap-2"
                    variant="outline"
                    onClick={() => {
                      navigate(`/companies/${selectedFieldOpp.company_id}?tab=opportunities`);
                      setSelectedFieldOpp(null);
                    }}
                    data-testid="btn-sheet-go-to-account"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Go to Account Opportunities
                  </Button>
                </>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>

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

      <AlertDialog open={!!confirmDismiss} onOpenChange={v => { if (!v) setConfirmDismiss(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from Top Opportunities?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{confirmDismiss?.companyName}</strong> will be hidden from this list. You can restore it at the bottom of the page.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="btn-cancel-dismiss">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => confirmDismiss && dismissMutation.mutate(confirmDismiss.companyId)}
              disabled={dismissMutation.isPending}
              data-testid="btn-confirm-dismiss"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
