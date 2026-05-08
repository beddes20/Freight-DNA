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
import { formatCustomerName } from "@shared/laneFormatters";
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
import { Input } from "@/components/ui/input";
import {
  Truck, MapPin, Flame, Package, TrendingUp, Building2,
  FileText, Zap, Plus, ExternalLink, Trash2, RotateCcw, EyeOff, ChevronDown,
  Users, Briefcase, DollarSign, Calendar, BarChart2, StickyNote, ChevronRight,
  Archive, Trophy, XCircle, Search,
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

type Dismissal = { company_id: string; company_name: string; dismissed_at: string; dismissed_by: string | null };

type SourceFreshness = { uploadedAt: string | null; uploaderName: string | null };

type SimpleUser = { id: string; name: string };

function formatFreshnessDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

function formatDismissedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso;
  }
}

const FRESHNESS_STALE_MS = 14 * 24 * 60 * 60 * 1000;

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

type ArchivedOpportunity = FieldCreatedOpportunity;

type ArchivedCompanyGroup = FieldCreatedCompanyGroup;

type OutcomeFilter = "all" | "closed_won" | "closed_lost";

type ViewMode = "rfp" | "field" | "archived";

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

  // Task #1140 — uploader-name lookup for the manager-only dismissals row.
  // Reuses the bare ["/api/users"] queryKey already used elsewhere in the
  // client (see User Management lifecycle gotcha — bare key is correct here).
  const { data: allUsers = [] } = useQuery<SimpleUser[]>({
    queryKey: ["/api/users"],
    enabled: canManage,
  });
  const userNameById = useMemo(() => {
    const map = new Map<string, string>();
    allUsers.forEach(u => { if (u?.id) map.set(u.id, u.name); });
    return map;
  }, [allUsers]);

  // Task #1140 — freight-data freshness pill (RFP view only).
  // `enabled` mirrors the JSX gate so the request never fires on the
  // Field-Created / Archived tabs (those views don't render the pill).
  const {
    data: sourceFreshness,
    isLoading: isFreshnessLoading,
    isError: isFreshnessError,
  } = useQuery<SourceFreshness>({
    queryKey: ["/api/opportunities/source-freshness"],
    enabled: viewMode === "rfp",
  });

  const { data: fieldOpportunities = [], isLoading: isFieldLoading } = useQuery<FieldCreatedOpportunity[]>({
    queryKey: ["/api/opportunities/field-created"],
  });

  const { data: archivedOpportunities = [], isLoading: isArchivedLoading } = useQuery<ArchivedOpportunity[]>({
    queryKey: ["/api/opportunities/archived"],
  });

  const [confirmDismiss, setConfirmDismiss] = useState<{ companyId: string; companyName: string } | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskPrefill, setTaskPrefill] = useState<TaskPrefill | null>(null);
  const [expandedCompanies, setExpandedCompanies] = useState<Record<string, boolean>>({});
  const [selectedFieldOpp, setSelectedFieldOpp] = useState<FieldCreatedOpportunity | null>(null);
  const [selectedArchivedOpp, setSelectedArchivedOpp] = useState<ArchivedOpportunity | null>(null);
  const [archiveOutcomeFilter, setArchiveOutcomeFilter] = useState<OutcomeFilter>("all");
  const [archiveSearch, setArchiveSearch] = useState("");

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
    // Sort by the cleaned customer label so the visible order matches the rendered names.
    return Array.from(map.values()).sort((a, b) =>
      formatCustomerName(a.companyName).localeCompare(formatCustomerName(b.companyName)),
    );
  }, [fieldOpportunities]);

  const filteredArchived = useMemo(() => {
    let list = archivedOpportunities;
    if (archiveOutcomeFilter !== "all") {
      list = list.filter(o => o.outcome === archiveOutcomeFilter);
    }
    if (archiveSearch.trim()) {
      const q = archiveSearch.trim().toLowerCase();
      list = list.filter(o => o.name.toLowerCase().includes(q) || o.company_name.toLowerCase().includes(q));
    }
    return list;
  }, [archivedOpportunities, archiveOutcomeFilter, archiveSearch]);

  const archivedByCompany = useMemo<ArchivedCompanyGroup[]>(() => {
    const map = new Map<string, ArchivedCompanyGroup>();
    filteredArchived.forEach(opp => {
      const key = opp.company_id ?? `__no_company__${opp.company_name}`;
      if (!map.has(key)) {
        map.set(key, { companyId: opp.company_id, companyName: opp.company_name || "Unknown Company", opportunities: [] });
      }
      map.get(key)!.opportunities.push(opp);
    });
    return Array.from(map.values()).sort((a, b) =>
      formatCustomerName(a.companyName).localeCompare(formatCustomerName(b.companyName)),
    );
  }, [filteredArchived]);

  const archiveSummary = useMemo(() => {
    const total = archivedOpportunities.length;
    const won = archivedOpportunities.filter(o => o.outcome === "closed_won");
    const lost = archivedOpportunities.filter(o => o.outcome === "closed_lost");
    const wonAmount = won.reduce((sum, o) => {
      const num = parseFloat((o.amount ?? "").replace(/[^0-9.]/g, ""));
      return sum + (isNaN(num) ? 0 : num);
    }, 0);
    return { total, wonCount: won.length, lostCount: lost.length, wonAmount };
  }, [archivedOpportunities]);

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
        <div className="flex items-center gap-2 flex-wrap">
          <Zap className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Top Opportunities</h1>
          {viewMode === "rfp" && (() => {
            // Task #1140 — three-state freshness pill (mirrors Task #1109a):
            // loading skeleton, neutral "unavailable" on fetch error, neutral
            // "empty" when there's no upload yet, neutral "fresh" otherwise,
            // amber "stale" past 14 days. Only rendered on the RFP view since
            // the other views don't depend on the financial upload.
            if (isFreshnessLoading) {
              return (
                <Skeleton
                  className="h-6 w-44 rounded-full"
                  data-testid="pill-freight-data-freshness"
                  data-freshness-state="loading"
                />
              );
            }
            if (isFreshnessError) {
              return (
                <Badge
                  variant="outline"
                  className="text-xs font-normal text-muted-foreground bg-muted/40"
                  data-testid="pill-freight-data-freshness"
                  data-freshness-state="unavailable"
                >
                  Freshness unavailable
                </Badge>
              );
            }
            if (!sourceFreshness?.uploadedAt) {
              return (
                <Badge
                  variant="outline"
                  className="text-xs font-normal text-muted-foreground bg-muted/40"
                  data-testid="pill-freight-data-freshness"
                  data-freshness-state="empty"
                >
                  No freight upload yet
                </Badge>
              );
            }
            const ts = new Date(sourceFreshness.uploadedAt).getTime();
            const isStaleUpload = Number.isFinite(ts) && (Date.now() - ts > FRESHNESS_STALE_MS);
            const dateLabel = formatFreshnessDate(sourceFreshness.uploadedAt);
            const uploader = sourceFreshness.uploaderName?.trim() || "Unknown";
            return (
              <Badge
                variant="outline"
                className={`text-xs font-normal ${
                  isStaleUpload
                    ? "text-amber-700 dark:text-amber-400 border-amber-500/40 bg-amber-500/10"
                    : "text-muted-foreground bg-muted/40"
                }`}
                data-testid="pill-freight-data-freshness"
                data-freshness-state={isStaleUpload ? "stale" : "fresh"}
                title={isStaleUpload
                  ? `Freight data is more than 14 days old — uploaded ${dateLabel} by ${uploader}`
                  : `Freight data uploaded ${dateLabel} by ${uploader}`}
              >
                Freight data as of {dateLabel} — {uploader}
              </Badge>
            );
          })()}
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          {viewMode === "rfp"
            ? "Accounts with RFP lanes that overlap our delivery zones — grouped by customer for easy follow-up."
            : viewMode === "field"
            ? "Manually entered CRM opportunities from your field sales team."
            : "Closed opportunities — won and lost — for historical reference."}
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
        <button
          type="button"
          onClick={() => handleViewChange("archived")}
          data-testid="btn-toggle-archived"
          className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
            viewMode === "archived"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Archive className="h-3.5 w-3.5" />
          Archived
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
                              {formatCustomerName(group.companyName)}
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
                            title="Hide this account from the Top Opportunities list for everyone in the org. Only managers can restore it."
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
                                    {formatCustomerName(group.companyName)}
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
                {dismissals.map(d => {
                  const dismisserName = d.dismissed_by ? (userNameById.get(d.dismissed_by) ?? "Unknown user") : "Unknown user";
                  const whenLabel = d.dismissed_at ? formatDismissedAt(d.dismissed_at) : null;
                  return (
                  <div key={d.company_id} className="flex items-center justify-between gap-2 text-sm py-1 border-b last:border-0" data-testid={`row-dismissed-${d.company_id}`}>
                    <div className="min-w-0 flex-1">
                      <div className="text-muted-foreground truncate">
                        {d.company_name ? formatCustomerName(d.company_name) : d.company_id}
                      </div>
                      <div className="text-xs text-muted-foreground/70 mt-0.5" data-testid={`text-dismissed-attribution-${d.company_id}`}>
                        Hidden by {dismisserName}{whenLabel ? ` on ${whenLabel}` : ""}
                      </div>
                    </div>
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
                  );
                })}
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
                          {formatCustomerName(group.companyName)}
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

      {/* Archived Opportunities View */}
      {viewMode === "archived" && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="archive-summary-banner">
            <Card className="bg-muted/30">
              <CardContent className="py-3 px-4 flex items-center gap-3">
                <Archive className="h-5 w-5 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Total Archived</p>
                  <p className="text-lg font-bold" data-testid="text-archive-total">{archiveSummary.total}</p>
                </div>
              </CardContent>
            </Card>
            <Card className="bg-green-500/5 border-green-500/20">
              <CardContent className="py-3 px-4 flex items-center gap-3">
                <Trophy className="h-5 w-5 text-green-600 shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Won</p>
                  <p className="text-lg font-bold text-green-600" data-testid="text-archive-won">{archiveSummary.wonCount}</p>
                </div>
              </CardContent>
            </Card>
            <Card className="bg-red-500/5 border-red-500/20">
              <CardContent className="py-3 px-4 flex items-center gap-3">
                <XCircle className="h-5 w-5 text-red-500 shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Lost</p>
                  <p className="text-lg font-bold text-red-500" data-testid="text-archive-lost">{archiveSummary.lostCount}</p>
                </div>
              </CardContent>
            </Card>
            <Card className="bg-green-500/5 border-green-500/20">
              <CardContent className="py-3 px-4 flex items-center gap-3">
                <DollarSign className="h-5 w-5 text-green-600 shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">Won Amount</p>
                  <p className="text-lg font-bold text-green-600" data-testid="text-archive-won-amount">
                    ${archiveSummary.wonAmount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or company..."
                value={archiveSearch}
                onChange={(e) => setArchiveSearch(e.target.value)}
                className="pl-9"
                data-testid="input-archive-search"
              />
            </div>
            <div className="inline-flex items-center rounded-full border bg-muted p-1 gap-1 shrink-0" data-testid="toggle-archive-outcome">
              {(["all", "closed_won", "closed_lost"] as OutcomeFilter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setArchiveOutcomeFilter(f)}
                  data-testid={`btn-archive-filter-${f}`}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    archiveOutcomeFilter === f
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {f === "all" ? "All" : f === "closed_won" ? "Won" : "Lost"}
                </button>
              ))}
            </div>
          </div>

          {isArchivedLoading ? (
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
          ) : archivedByCompany.length === 0 ? (
            <Card>
              <CardContent className="py-20 text-center" data-testid="archive-empty-state">
                <Archive className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <p className="font-semibold text-lg text-muted-foreground">No archived opportunities</p>
                <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
                  {archiveSearch || archiveOutcomeFilter !== "all"
                    ? "No opportunities match your current filters. Try adjusting your search or outcome filter."
                    : "Opportunities will appear here once they are marked as Closed Won or Closed Lost."}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4" data-testid="archived-opportunities-list">
              {archivedByCompany.map((group) => (
                <Card key={group.companyId ?? group.companyName} data-testid={`card-archived-company-${group.companyId ?? group.companyName}`} className="overflow-hidden">
                  <CardHeader className="pb-3 bg-gradient-to-r from-primary/5 to-transparent border-b">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-primary" />
                        <span
                          className={`font-semibold text-base text-primary ${group.companyId ? "hover:underline cursor-pointer" : ""}`}
                          data-testid={`text-archived-company-name-${group.companyId ?? group.companyName}`}
                          onClick={() => group.companyId ? navigate(`/companies/${group.companyId}?tab=opportunities`) : undefined}
                        >
                          {formatCustomerName(group.companyName)}
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
                          onClick={() => navigate(`/companies/${group.companyId}?tab=opportunities`)}
                          data-testid={`btn-archived-view-account-${group.companyId}`}
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
                          data-testid={`row-archived-opportunity-${opp.id}`}
                          className="px-4 py-3 hover:bg-muted/40 transition-colors cursor-pointer group"
                          onClick={() => setSelectedArchivedOpp(opp)}
                        >
                          <div className="flex items-center justify-between gap-3 flex-wrap">
                            <div className="flex items-center gap-2 min-w-0">
                              <Briefcase className="h-4 w-4 text-muted-foreground shrink-0" />
                              <span className="font-medium text-sm" data-testid={`text-archived-opp-name-${opp.id}`}>
                                {opp.name}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge variant="secondary" className="text-xs" data-testid={`badge-archived-record-type-${opp.id}`}>
                                {getRecordTypeLabel(opp.record_type)}
                              </Badge>
                              <Badge
                                variant={opp.outcome === "closed_won" ? "default" : "destructive"}
                                className={`text-xs ${opp.outcome === "closed_won" ? "bg-green-600 hover:bg-green-700" : ""}`}
                                data-testid={`badge-archived-outcome-${opp.id}`}
                              >
                                {opp.outcome === "closed_won" ? "Won" : "Lost"}
                              </Badge>
                              {opp.amount && (
                                <Badge variant="outline" className="text-xs font-mono" data-testid={`badge-archived-amount-${opp.id}`}>
                                  {opp.amount}
                                </Badge>
                              )}
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

      {/* Archived Opportunity Detail Sheet */}
      <Sheet open={!!selectedArchivedOpp} onOpenChange={(open) => { if (!open) setSelectedArchivedOpp(null); }}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto" data-testid="sheet-archived-opp-detail">
          {selectedArchivedOpp && (
            <>
              <SheetHeader className="mb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Briefcase className="h-5 w-5 text-primary" />
                  <Badge variant="secondary" className="text-xs">{getRecordTypeLabel(selectedArchivedOpp.record_type)}</Badge>
                  <Badge
                    variant={selectedArchivedOpp.outcome === "closed_won" ? "default" : "destructive"}
                    className={`text-xs ${selectedArchivedOpp.outcome === "closed_won" ? "bg-green-600 hover:bg-green-700" : ""}`}
                  >
                    {selectedArchivedOpp.outcome === "closed_won" ? "Won" : "Lost"}
                  </Badge>
                </div>
                <SheetTitle className="text-lg leading-tight" data-testid="text-archived-sheet-opp-name">{selectedArchivedOpp.name}</SheetTitle>
                {selectedArchivedOpp.company_name && (
                  <SheetDescription className="flex items-center gap-1 mt-1">
                    <Building2 className="h-3.5 w-3.5" />
                    {formatCustomerName(selectedArchivedOpp.company_name)}
                  </SheetDescription>
                )}
              </SheetHeader>

              <Separator className="mb-4" />

              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Details</p>
                  <div className="grid grid-cols-2 gap-3">
                    {selectedArchivedOpp.amount && (
                      <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2">
                        <DollarSign className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-xs text-muted-foreground">Amount</p>
                          <p className="text-sm font-semibold" data-testid="text-archived-sheet-amount">{selectedArchivedOpp.amount}</p>
                        </div>
                      </div>
                    )}
                    {selectedArchivedOpp.close_date && (
                      <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2">
                        <Calendar className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-xs text-muted-foreground">Close Date</p>
                          <p className="text-sm font-semibold" data-testid="text-archived-sheet-close-date">{selectedArchivedOpp.close_date}</p>
                        </div>
                      </div>
                    )}
                    <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2">
                      <BarChart2 className="h-4 w-4 text-purple-500 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-xs text-muted-foreground">Stage</p>
                        <p className="text-sm font-semibold" data-testid="text-archived-sheet-stage">{getStageLabel(selectedArchivedOpp.stage)}</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2">
                      <Briefcase className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                      <div>
                        <p className="text-xs text-muted-foreground">Record Type</p>
                        <p className="text-sm font-semibold" data-testid="text-archived-sheet-record-type">{getRecordTypeLabel(selectedArchivedOpp.record_type)}</p>
                      </div>
                    </div>
                  </div>
                </div>

                {selectedArchivedOpp.notes && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                      <StickyNote className="h-3.5 w-3.5" /> Notes
                    </p>
                    <p className="text-sm text-foreground/80 bg-muted/30 rounded-md px-3 py-2 whitespace-pre-wrap" data-testid="text-archived-sheet-notes">{selectedArchivedOpp.notes}</p>
                  </div>
                )}

                {selectedArchivedOpp.lost_reason && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lost Reason</p>
                    <p className="text-sm text-foreground/80 bg-destructive/10 rounded-md px-3 py-2" data-testid="text-archived-sheet-lost-reason">{selectedArchivedOpp.lost_reason}</p>
                  </div>
                )}

                {selectedArchivedOpp.created_at && (
                  <p className="text-xs text-muted-foreground">
                    Created {new Date(selectedArchivedOpp.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </p>
                )}
              </div>

              {selectedArchivedOpp.company_id && (
                <>
                  <Separator className="my-4" />
                  <Button
                    className="w-full gap-2"
                    variant="outline"
                    onClick={() => {
                      navigate(`/companies/${selectedArchivedOpp.company_id}?tab=opportunities`);
                      setSelectedArchivedOpp(null);
                    }}
                    data-testid="btn-archived-sheet-go-to-account"
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
                    {formatCustomerName(selectedFieldOpp.company_name)}
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
            <AlertDialogTitle>Hide from Top Opportunities for the whole org?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{confirmDismiss?.companyName ? formatCustomerName(confirmDismiss.companyName) : ""}</strong> will be hidden from the RFP / Mini-Bid Matches list <strong>for every rep in the org</strong>, not just you. Only managers can restore it from the &ldquo;Removed from list&rdquo; section at the bottom of this page.
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
