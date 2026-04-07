import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Building2,
  Plus,
  Search,
  Users,
  Network,
  ChevronRight,
  AlertTriangle,
  Archive,
  ArchiveX,
  DollarSign,
  Truck,
  PhoneCall,
  SlidersHorizontal,
  X,
  UserCheck,
  ArrowUpDown,
  Bookmark,
  BookmarkCheck,
  UserPlus,
  Clock,
  Mail,
  MessageSquare,
  MapPin,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CompanyDialog } from "@/components/company-dialog";
import { GrowthScoreBadge } from "@/components/account-growth-portlet";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateAfterTouchpoint } from "@/lib/invalidations";
import { buildAiToasts } from "@/lib/aiTouchUtils";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { fmtMoney } from "@/lib/rep-utils";
import type { Company, Contact, User, SharedRep } from "@shared/schema";

type MonthBucket = { totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue?: number };
type AccountSummaryRow = {
  customerName: string;
  totalLoads: number;
  spotLoads: number;
  totalMargin: number;
  totalRevenue?: number;
  repName?: string;
  byMonth?: Record<string, MonthBucket>;
};

type TouchpointSummary = Record<string, { week: number; month: number; lastType: string | null; lastDate: string | null; daysSince: number | null }>;

function matchFinancials(name: string, rows: AccountSummaryRow[]): AccountSummaryRow | null {
  if (!rows.length) return null;
  const lower = name.toLowerCase();

  const matches = rows.filter(r => {
    const rName = r.customerName.toLowerCase();
    return rName === lower ||
      (name.length >= 5 && (rName.includes(lower) || lower.includes(rName)));
  });

  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];

  // Aggregate all matching rows (e.g. same customer split across multiple reps)
  const agg: AccountSummaryRow = {
    customerName: matches[0].customerName,
    totalLoads: 0,
    spotLoads: 0,
    totalMargin: 0,
    totalRevenue: 0,
    byMonth: {},
  };
  for (const m of matches) {
    agg.totalLoads += m.totalLoads;
    agg.spotLoads += m.spotLoads;
    agg.totalMargin += m.totalMargin;
    agg.totalRevenue = (agg.totalRevenue ?? 0) + (m.totalRevenue ?? 0);
    if (m.byMonth) {
      for (const [mo, bucket] of Object.entries(m.byMonth)) {
        if (!agg.byMonth![mo]) agg.byMonth![mo] = { totalLoads: 0, spotLoads: 0, totalMargin: 0, totalRevenue: 0 };
        agg.byMonth![mo].totalLoads += bucket.totalLoads;
        agg.byMonth![mo].spotLoads += bucket.spotLoads;
        agg.byMonth![mo].totalMargin += bucket.totalMargin;
        agg.byMonth![mo].totalRevenue = (agg.byMonth![mo].totalRevenue ?? 0) + (bucket.totalRevenue ?? 0);
      }
    }
  }
  return agg;
}

function getCompanyFinancials(company: Company, accountSummary: AccountSummaryRow[]): AccountSummaryRow | null {
  const aliases = (company as any).financialAlias
    ? (company as any).financialAlias.split(',').map((a: string) => a.trim()).filter(Boolean)
    : [];

  const partials: AccountSummaryRow[] = [];
  for (const alias of aliases) {
    const match = matchFinancials(alias, accountSummary);
    if (match) partials.push(match);
  }

  if (!partials.length) return matchFinancials(company.name, accountSummary);
  if (partials.length === 1) return partials[0];

  const agg: AccountSummaryRow = {
    customerName: partials[0].customerName,
    totalLoads: 0,
    spotLoads: 0,
    totalMargin: 0,
    totalRevenue: 0,
    byMonth: {},
  };
  for (const m of partials) {
    agg.totalLoads += m.totalLoads;
    agg.spotLoads += m.spotLoads;
    agg.totalMargin += m.totalMargin;
    agg.totalRevenue = (agg.totalRevenue ?? 0) + (m.totalRevenue ?? 0);
    if (m.byMonth) {
      for (const [mo, bucket] of Object.entries(m.byMonth)) {
        if (!agg.byMonth![mo]) agg.byMonth![mo] = { totalLoads: 0, spotLoads: 0, totalMargin: 0, totalRevenue: 0 };
        agg.byMonth![mo].totalLoads += bucket.totalLoads;
        agg.byMonth![mo].spotLoads += bucket.spotLoads;
        agg.byMonth![mo].totalMargin += bucket.totalMargin;
        agg.byMonth![mo].totalRevenue = (agg.byMonth![mo].totalRevenue ?? 0) + (bucket.totalRevenue ?? 0);
      }
    }
  }
  return agg;
}

export default function Customers() {
  const { user: currentUser } = useAuth();
  const { toast } = useToast();

  const initParam = (key: string, fallback = "all") => {
    const p = new URLSearchParams(window.location.search);
    return p.get(key) || fallback;
  };

  const [searchQuery, setSearchQuery] = useState(() => initParam("q", ""));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showFilters, setShowFilters] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    return ["rep", "industry", "touch"].some(k => p.has(k) && p.get(k) !== "all");
  });
  const [repFilter, setRepFilter] = useState(() => initParam("rep"));
  const [industryFilter, setIndustryFilter] = useState(() => initParam("industry"));
  const [touchFilter, setTouchFilter] = useState(() => initParam("touch"));
  const [modeFilter, setModeFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState(() => initParam("sort", "name"));

  useEffect(() => {
    const p = new URLSearchParams();
    if (searchQuery) p.set("q", searchQuery);
    if (repFilter !== "all") p.set("rep", repFilter);
    if (industryFilter !== "all") p.set("industry", industryFilter);
    if (touchFilter !== "all") p.set("touch", touchFilter);
    if (sortBy !== "name") p.set("sort", sortBy);
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [searchQuery, repFilter, industryFilter, touchFilter, sortBy]);

  const [quickTouch, setQuickTouch] = useState<{ company: Company; contacts: Contact[] } | null>(null);
  const [quickTouchContactId, setQuickTouchContactId] = useState("");
  const [quickTouchType, setQuickTouchType] = useState("call");
  const [quickTouchNote, setQuickTouchNote] = useState("");
  const [quickTouchSentiment, setQuickTouchSentiment] = useState("");
  const [quickTouchMeaningful, setQuickTouchMeaningful] = useState(false);

  const [quickAddContact, setQuickAddContact] = useState<Company | null>(null);
  const [quickAddName, setQuickAddName] = useState("");
  const [quickAddTitle, setQuickAddTitle] = useState("");
  const [quickAddEmail, setQuickAddEmail] = useState("");
  const [quickAddPhone, setQuickAddPhone] = useState("");
  const [saveFilterName, setSaveFilterName] = useState("");
  const [showSaveFilter, setShowSaveFilter] = useState(false);

  type SavedFilter = { name: string; rep: string; industry: string; touch: string; sort: string };

  const { data: savedFiltersData } = useQuery<{ filters: SavedFilter[] }>({
    queryKey: ["/api/users/saved-filters"],
  });
  const savedFilters: SavedFilter[] = savedFiltersData?.filters || [];

  const saveFilterMutation = useMutation({
    mutationFn: (filters: SavedFilter[]) => apiRequest("PUT", "/api/users/saved-filters", { filters }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users/saved-filters"] });
      setSaveFilterName("");
      setShowSaveFilter(false);
      toast({ title: "Filter preset saved!" });
    },
  });

  const handleSaveFilter = () => {
    if (!saveFilterName.trim()) return;
    const newFilter: SavedFilter = { name: saveFilterName.trim(), rep: repFilter, industry: industryFilter, touch: touchFilter, sort: sortBy };
    saveFilterMutation.mutate([...savedFilters.filter(f => f.name !== newFilter.name), newFilter]);
  };

  const handleLoadFilter = (f: SavedFilter) => {
    setRepFilter(f.rep || "all");
    setIndustryFilter(f.industry || "all");
    setTouchFilter(f.touch || "all");
    setSortBy(f.sort || "name");
  };

  const handleDeleteFilter = (name: string) => {
    saveFilterMutation.mutate(savedFilters.filter(f => f.name !== name));
  };

  const logTouchMutation = useMutation({
    mutationFn: ({ contactId, type, notes, sentiment, isMeaningful }: { contactId: string; type: string; notes: string; sentiment?: string; isMeaningful?: boolean }) =>
      apiRequest("POST", `/api/contacts/${contactId}/touchpoints`, { type, date: new Date().toISOString().slice(0, 10), notes, sentiment: sentiment || null, isMeaningful: isMeaningful || false }).then(r => r.json()),
    onSuccess: (data: any) => {
      invalidateAfterTouchpoint(data?.companyId);
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      toast({ title: "Touch logged!" });
      buildAiToasts(data?.aiInsights, data?.autoTask, toast);
      setQuickTouch(null);
      setQuickTouchContactId("");
      setQuickTouchType("call");
      setQuickTouchNote("");
      setQuickTouchSentiment("");
      setQuickTouchMeaningful(false);
    },
    onError: () => toast({ title: "Failed to log touch", variant: "destructive" }),
  });

  const addContactMutation = useMutation({
    mutationFn: (data: { companyId: string; name: string; title?: string; email?: string; phone?: string }) =>
      apiRequest("POST", `/api/companies/${data.companyId}/contacts`, { ...data, createdAt: new Date().toISOString().slice(0, 10) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      toast({ title: "Contact added!" });
      setQuickAddContact(null);
      setQuickAddName(""); setQuickAddTitle(""); setQuickAddEmail(""); setQuickAddPhone("");
    },
    onError: () => toast({ title: "Failed to add contact", variant: "destructive" }),
  });

  const { data: companies, isLoading: companiesLoading } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const { data: archivedCompanies, isLoading: archivedLoading } = useQuery<Company[]>({
    queryKey: ["/api/companies", { includeArchived: true }],
    queryFn: async () => {
      const res = await fetch("/api/companies?includeArchived=true", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      const all: Company[] = await res.json();
      return all.filter(c => c.archivedAt);
    },
    enabled: showArchived,
  });

  const { data: allContacts } = useQuery<Contact[]>({
    queryKey: ["/api/contacts"],
  });

  const { data: researchTasks } = useQuery<any[]>({
    queryKey: ["/api/research-tasks"],
  });

  const { data: accountSummary = [] } = useQuery<AccountSummaryRow[]>({
    queryKey: ["/api/financials/account-summary"],
  });

  const { data: teamMembers = [] } = useQuery<Omit<User, "password">[]>({
    queryKey: ["/api/team-members"],
  });

  const { data: salesUsers = [] } = useQuery<Omit<User, "password">[]>({
    queryKey: ["/api/users/sales"],
  });
  const salesPersonMap = new Map(salesUsers.map(u => [u.id, u.name]));

  type MsSummaryRow = { companyId: string; currentPct: number | null };
  const { data: msSummary = [] } = useQuery<MsSummaryRow[]>({
    queryKey: ["/api/market-share/summary"],
  });
  const msMap = useMemo(() => new Map(msSummary.map(r => [r.companyId, r.currentPct ?? 0])), [msSummary]);

  type GrowthScoreRow = { companyId: string; score: number; band: string; bandLabel: string };
  const { data: growthScores = [] } = useQuery<GrowthScoreRow[]>({
    queryKey: ["/api/growth-scores"],
    staleTime: 10 * 60 * 1000,
  });
  const growthScoreMap = useMemo(() => new Map(growthScores.map(r => [r.companyId, r])), [growthScores]);

  const thisMonthKey = (() => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
  })();

  const { data: tpSummary = {} } = useQuery<TouchpointSummary>({
    queryKey: ["/api/touchpoints/company-summary"],
  });

  const contactsByCompany = new Map<string, Contact[]>();
  allContacts?.forEach((c) => {
    const list = contactsByCompany.get(c.companyId) || [];
    list.push(c);
    contactsByCompany.set(c.companyId, list);
  });

  const openTasksByCompany = new Map<string, number>();
  researchTasks?.forEach((t) => {
    if (t.status === "open") {
      openTasksByCompany.set(t.companyId, (openTasksByCompany.get(t.companyId) || 0) + 1);
    }
  });

  // Derive unique industries for the filter dropdown
  const uniqueIndustries = useMemo(() => {
    const set = new Set<string>();
    companies?.forEach(c => { if (c.industry) set.add(c.industry); });
    return Array.from(set).sort();
  }, [companies]);

  // Derive assignable users for the rep filter dropdown — all non-admin roles can own accounts
  const isAdminOrDirector = currentUser?.role === "admin" || currentUser?.role === "director";
  const amUsers = useMemo(() => {
    return teamMembers
      .filter(u => u.role !== "admin")
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [teamMembers]);

  // Set of NAM/AM user IDs so we can filter company lists
  const namAmIds = useMemo(() => new Set(amUsers.map(u => u.id)), [amUsers]);

  const activeFiltersCount = [repFilter !== "all", industryFilter !== "all", touchFilter !== "all", modeFilter !== "all"].filter(Boolean).length;

  function applyFilters(list: Company[] | undefined) {
    if (!list) return [];
    const filtered = list.filter(company => {
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!company.name.toLowerCase().includes(q) && !company.industry?.toLowerCase().includes(q)) return false;
      }
      const sharedRepIds = ((company.sharedReps || []) as SharedRep[]).map(r => r.userId);
      if (isAdminOrDirector && repFilter === "all" && company.assignedTo && !namAmIds.has(company.assignedTo) && !sharedRepIds.some(id => namAmIds.has(id))) return false;
      if (repFilter !== "all" && company.assignedTo !== repFilter && !sharedRepIds.includes(repFilter)) return false;
      if (industryFilter !== "all" && company.industry !== industryFilter) return false;
      if (touchFilter !== "all") {
        const tps = tpSummary[company.id] || { week: 0, month: 0, lastType: null, lastDate: null, daysSince: null };
        if (touchFilter === "not_this_month" && tps.month > 0) return false;
        if (touchFilter === "not_this_week" && tps.week > 0) return false;
        if (touchFilter === "needs_attention" && tps.month > 0) return false;
      }
      if (modeFilter !== "all") {
        const modes: string[] = (company as any).shippingModes || [];
        if (!modes.includes(modeFilter)) return false;
      }
      return true;
    });

    const getFinVal = (company: Company, key: "totalLoads" | "totalMargin" | "marginPct") => {
      const fin = getCompanyFinancials(company, accountSummary);
      if (!fin) return -1;
      if (key === "marginPct") return fin.totalRevenue && fin.totalRevenue > 0 ? fin.totalMargin / fin.totalRevenue : -1;
      return fin[key];
    };

    return filtered.sort((a, b) => {
      switch (sortBy) {
        case "loads_desc":   return getFinVal(b, "totalLoads") - getFinVal(a, "totalLoads");
        case "margin_desc":  return getFinVal(b, "totalMargin") - getFinVal(a, "totalMargin");
        case "ms_desc":      return (msMap.get(b.id) ?? -1) - (msMap.get(a.id) ?? -1);
        case "margin_pct_desc": return getFinVal(b, "marginPct") - getFinVal(a, "marginPct");
        case "score_desc":   return (growthScoreMap.get(b.id)?.score ?? -1) - (growthScoreMap.get(a.id)?.score ?? -1);
        case "score_asc":    return (growthScoreMap.get(a.id)?.score ?? 101) - (growthScoreMap.get(b.id)?.score ?? 101);
        default:             return a.name.localeCompare(b.name);
      }
    });
  }

  const displayList = applyFilters(showArchived ? archivedCompanies : companies);
  const isLoading = showArchived ? archivedLoading : companiesLoading;

  function clearFilters() {
    setRepFilter("all");
    setIndustryFilter("all");
    setTouchFilter("all");
    setModeFilter("all");
  }

  return (
    <div className="flex flex-col gap-4 sm:gap-6 p-4 sm:p-6" data-tour="tour-companies-table">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-customers-title">
            {showArchived ? "Archived Accounts" : "Customers"}
          </h1>
          <p className="text-muted-foreground">
            {showArchived ? "Accounts that have been parked — click to view or restore" : "View customer org charts and manage contacts"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={showArchived ? "default" : "outline"}
            onClick={() => setShowArchived(v => !v)}
            data-testid="button-toggle-archived"
          >
            {showArchived ? (
              <><ArchiveX className="h-4 w-4 mr-2" />Show Active</>
            ) : (
              <><Archive className="h-4 w-4 mr-2" />Archived</>
            )}
          </Button>
          {!showArchived && (
            <Button onClick={() => setDialogOpen(true)} data-testid="button-add-customer">
              <Plus className="h-4 w-4 mr-2" />
              Add Customer
            </Button>
          )}
        </div>
      </div>

      {/* Search + Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={showArchived ? "Search archived..." : "Search customers..."}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-customers"
          />
        </div>
        {!showArchived && (
          <Button
            variant={showFilters || activeFiltersCount > 0 ? "default" : "outline"}
            size="sm"
            className="gap-1.5 h-9"
            onClick={() => setShowFilters(v => !v)}
            data-testid="button-toggle-filters"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Filters
            {activeFiltersCount > 0 && (
              <Badge className="ml-1 h-4 w-4 p-0 flex items-center justify-center text-[10px] bg-white text-primary">
                {activeFiltersCount}
              </Badge>
            )}
          </Button>
        )}
        {activeFiltersCount > 0 && (
          <Button variant="ghost" size="sm" className="h-9 gap-1 text-muted-foreground" onClick={clearFilters} data-testid="button-clear-filters">
            <X className="h-3.5 w-3.5" /> Clear
          </Button>
        )}
        {!showArchived && (
          <div className="flex items-center gap-1.5 ml-auto">
            <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="h-9 text-sm w-[170px]" data-testid="select-sort-by">
                <SelectValue placeholder="Sort by…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">Name (A–Z)</SelectItem>
                <SelectItem value="loads_desc">Highest Load Count</SelectItem>
                <SelectItem value="margin_desc">Highest Margin $</SelectItem>
                <SelectItem value="margin_pct_desc">Highest Margin %</SelectItem>
                <SelectItem value="score_desc">Highest Growth Score</SelectItem>
                <SelectItem value="score_asc">At Risk First</SelectItem>
                <SelectItem value="ms_desc">Highest Market Share</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {showArchived && !isLoading && (
          <span className="text-sm text-muted-foreground ml-auto">
            {displayList.length} account{displayList.length !== 1 ? "s" : ""}
          </span>
        )}
        {!showArchived && !isLoading && (
          <span className="text-sm text-muted-foreground">
            {displayList.length} account{displayList.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {showFilters && !showArchived && (
        <div className="flex items-center gap-3 flex-wrap p-3 bg-muted/40 rounded-lg border" data-testid="filter-bar">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">Rep</span>
            <Select value={repFilter} onValueChange={setRepFilter}>
              <SelectTrigger className="h-8 text-sm w-[160px]" data-testid="select-filter-rep">
                <SelectValue placeholder="All reps" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All reps</SelectItem>
                {amUsers.map(u => (
                  <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">Industry</span>
            <Select value={industryFilter} onValueChange={setIndustryFilter}>
              <SelectTrigger className="h-8 text-sm w-[160px]" data-testid="select-filter-industry">
                <SelectValue placeholder="All industries" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All industries</SelectItem>
                {uniqueIndustries.map(ind => (
                  <SelectItem key={ind} value={ind}>{ind}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">Activity</span>
            <Select value={touchFilter} onValueChange={setTouchFilter}>
              <SelectTrigger className="h-8 text-sm w-[180px]" data-testid="select-filter-touch">
                <SelectValue placeholder="Any activity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any activity</SelectItem>
                <SelectItem value="needs_attention">Needs attention (30+ days)</SelectItem>
                <SelectItem value="not_this_week">Not touched this week</SelectItem>
                <SelectItem value="not_this_month">Not touched this month</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">Mode</span>
            {["LTL", "FTL", "Drayage", "IMDL"].map(mode => (
              <button
                key={mode}
                onClick={() => setModeFilter(modeFilter === mode ? "all" : mode)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${modeFilter === mode ? "bg-blue-600 text-white border-blue-600" : "bg-background border-border text-muted-foreground hover:border-blue-400 hover:text-blue-600"}`}
                data-testid={`button-mode-filter-${mode.toLowerCase()}`}
              >
                {mode}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {savedFilters.length > 0 && savedFilters.map(f => (
              <div key={f.name} className="flex items-center gap-0.5">
                <button
                  onClick={() => handleLoadFilter(f)}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-border bg-background hover:bg-muted transition-colors"
                  data-testid={`button-load-filter-${f.name}`}
                >
                  <BookmarkCheck className="h-3 w-3 text-blue-500" />
                  {f.name}
                </button>
                <button onClick={() => handleDeleteFilter(f.name)} className="text-muted-foreground hover:text-destructive p-0.5" data-testid={`button-delete-filter-${f.name}`}>
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {!showSaveFilter ? (
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => setShowSaveFilter(true)} data-testid="button-show-save-filter">
                <Bookmark className="h-3.5 w-3.5" /> Save
              </Button>
            ) : (
              <div className="flex items-center gap-1">
                <Input
                  value={saveFilterName}
                  onChange={e => setSaveFilterName(e.target.value)}
                  placeholder="Filter name"
                  className="h-7 text-xs w-24"
                  onKeyDown={e => { if (e.key === "Enter") handleSaveFilter(); if (e.key === "Escape") setShowSaveFilter(false); }}
                  autoFocus
                  data-testid="input-save-filter-name"
                />
                <Button size="sm" className="h-7 text-xs px-2" onClick={handleSaveFilter} disabled={!saveFilterName.trim() || saveFilterMutation.isPending} data-testid="button-confirm-save-filter">Save</Button>
                <Button variant="ghost" size="sm" className="h-7 px-1" onClick={() => setShowSaveFilter(false)}><X className="h-3.5 w-3.5" /></Button>
              </div>
            )}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-12 w-full mb-3" />
                <Skeleton className="h-4 w-3/4 mb-2" />
                <Skeleton className="h-4 w-1/2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : displayList && displayList.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {displayList.map((company) => {
            const contacts = contactsByCompany.get(company.id) || [];
            const openTasks = openTasksByCompany.get(company.id) || 0;
            const fin = getCompanyFinancials(company, accountSummary);
            const tps = tpSummary[company.id] || { week: 0, month: 0, lastType: null, lastDate: null, daysSince: null };
            return (
              <Link key={company.id} href={`/companies/${company.id}`}>
                <Card className="hover-elevate cursor-pointer h-full" data-testid={`card-customer-${company.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${company.archivedAt ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"}`}>
                          {company.archivedAt ? <Archive className="h-5 w-5" /> : <Building2 className="h-5 w-5" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <h3 className="font-medium truncate" data-testid={`text-customer-name-${company.id}`}>
                              {company.name}
                            </h3>
                            {company.archivedAt && (
                              <Badge variant="secondary" className="text-xs shrink-0">Archived</Badge>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground truncate">
                            {company.industry || "No industry specified"}
                          </p>
                          {(() => {
                            const spId = (company as any).salesPersonId as string | null;
                            const spName = spId ? salesPersonMap.get(spId) : null;
                            if (!spName) return null;
                            return (
                              <p className="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-1 mt-0.5" data-testid={`text-salesperson-${company.id}`}>
                                <UserCheck className="h-3 w-3" />
                                {spName}
                              </p>
                            );
                          })()}
                        </div>
                      </div>
                      {!company.archivedAt && (
                        <div className="flex items-center gap-1">
                          {contacts.length > 0 && (
                            <button
                              className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                              title="Quick log touch"
                              data-testid={`button-quick-touch-${company.id}`}
                              onClick={e => {
                                e.preventDefault();
                                e.stopPropagation();
                                setQuickTouch({ company, contacts });
                                setQuickTouchContactId(contacts[0]?.id ?? "");
                              }}
                            >
                              <PhoneCall className="h-4 w-4" />
                            </button>
                          )}
                          <button
                            className="p-1 rounded text-muted-foreground hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors"
                            title="Quick add contact"
                            data-testid={`button-quick-add-contact-${company.id}`}
                            onClick={e => {
                              e.preventDefault();
                              e.stopPropagation();
                              setQuickAddContact(company);
                            }}
                          >
                            <UserPlus className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                      <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
                    </div>

                    <div className="mt-3 flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Users className="h-3.5 w-3.5" />
                        <span>{contacts.length} contact{contacts.length !== 1 ? "s" : ""}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Network className="h-3.5 w-3.5" />
                        <span>Org Chart</span>
                      </div>
                      {!company.archivedAt && (() => {
                        const gs = growthScoreMap.get(company.id);
                        if (!gs) return null;
                        return <GrowthScoreBadge score={gs.score} band={gs.band} bandLabel={gs.bandLabel} />;
                      })()}
                      {openTasks > 0 && !company.archivedAt && (
                        <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs">
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          {openTasks} lane{openTasks !== 1 ? "s" : ""} need research
                        </Badge>
                      )}
                      {company.archivedAt && (
                        <span className="text-xs text-muted-foreground">
                          Archived {new Date(company.archivedAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>

                    {(company as any).accountSummary && (
                      <p className="mt-2 text-xs text-muted-foreground line-clamp-2 italic leading-relaxed">
                        {(company as any).accountSummary}
                      </p>
                    )}

                    {!company.archivedAt && (
                      <div className="mt-3 pt-3 border-t flex items-center gap-4 flex-wrap">
                        {fin ? (
                          <>
                            {(() => {
                              const hasMonthly = fin.byMonth && Object.keys(fin.byMonth).length > 0;
                              const m = fin.byMonth?.[thisMonthKey];
                              // If monthly data exists, only show current month (not all-time totals)
                              if (hasMonthly && !m) return (
                                <span className="text-xs text-muted-foreground italic">No loads this month</span>
                              );
                              const loads = m ? m.totalLoads : fin.totalLoads;
                              const margin = m ? m.totalMargin : fin.totalMargin;
                              const revenue = m ? (m.totalRevenue ?? 0) : (fin.totalRevenue ?? 0);
                              const marginPct = revenue > 0 ? (margin / revenue) * 100 : null;
                              const label = m ? "mo." : "";
                              return (
                                <>
                                  <div className="flex items-center gap-1.5 text-xs" title={m ? "This month's loads" : "Total loads (financial data)"}>
                                    <Truck className="h-3.5 w-3.5 text-blue-500" />
                                    <span className="font-medium text-foreground">{loads.toLocaleString()}</span>
                                    <span className="text-muted-foreground">loads{label ? ` ${label}` : ""}</span>
                                  </div>
                                  <div className="flex items-center gap-1.5 text-xs" title={m ? "This month's margin" : "Total margin (financial data)"}>
                                    <DollarSign className="h-3.5 w-3.5 text-green-500" />
                                    <span className={`font-medium ${margin < 0 ? "text-red-500 dark:text-red-400" : "text-foreground"}`}>
                                      {fmtMoney(margin)}
                                    </span>
                                    <span className="text-muted-foreground">margin{label ? ` ${label}` : ""}</span>
                                  </div>
                                  {marginPct !== null && (
                                    <div className="flex items-center gap-1.5 text-xs" title="Margin % (margin / revenue)">
                                      <span className={`font-medium ${marginPct < 0 ? "text-red-500 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                                        {marginPct.toFixed(1)}%
                                      </span>
                                      <span className="text-muted-foreground">margin%</span>
                                    </div>
                                  )}
                                </>
                              );
                            })()}
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">No financial data</span>
                        )}
                        {(() => {
                          if (tps.daysSince === null && !tps.lastType) return null;
                          const d = tps.daysSince ?? 999;
                          const urgency = d <= 7 ? "text-emerald-600 dark:text-emerald-400" : d <= 14 ? "text-amber-500 dark:text-amber-400" : d <= 30 ? "text-orange-500 dark:text-orange-400" : "text-red-500 dark:text-red-400";
                          const TypeIcon = tps.lastType === "email" ? Mail : tps.lastType === "text" ? MessageSquare : tps.lastType === "site_visit" ? MapPin : PhoneCall;
                          const label = d === 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
                          return (
                            <div className={`flex items-center gap-1 text-xs ml-auto ${urgency}`} title={`Last touch: ${tps.lastType} ${label}`}>
                              <TypeIcon className="h-3 w-3" />
                              <span>{label}</span>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-16 text-muted-foreground">
          <Building2 className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">
            {activeFiltersCount > 0 || searchQuery ? "No accounts match your filters" : (showArchived ? "No archived accounts" : "No customers yet")}
          </p>
          {(activeFiltersCount > 0 || searchQuery) && (
            <Button variant="ghost" size="sm" className="mt-3" onClick={() => { clearFilters(); setSearchQuery(""); }}>
              Clear all filters
            </Button>
          )}
        </div>
      )}

      <CompanyDialog open={dialogOpen} onOpenChange={setDialogOpen} />

      <Dialog open={!!quickTouch} onOpenChange={() => { setQuickTouch(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Quick Log Touch — {quickTouch?.company.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-sm font-medium block mb-1">Contact</label>
              <Select value={quickTouchContactId} onValueChange={setQuickTouchContactId}>
                <SelectTrigger data-testid="select-quick-touch-contact">
                  <SelectValue placeholder="Select contact..." />
                </SelectTrigger>
                <SelectContent>
                  {quickTouch?.contacts.map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Type</label>
              <Select value={quickTouchType} onValueChange={setQuickTouchType}>
                <SelectTrigger data-testid="select-quick-touch-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="call">Call</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="text">Text</SelectItem>
                  <SelectItem value="site_visit">Site Visit</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {/* Meaningful toggle */}
            <div className="flex items-center gap-3 py-0.5">
              <button
                type="button"
                onClick={() => setQuickTouchMeaningful(v => !v)}
                data-testid="button-meaningful-toggle-customers"
                className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${quickTouchMeaningful ? "bg-green-500" : "bg-muted border border-border"}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${quickTouchMeaningful ? "left-4" : "left-0.5"}`} />
              </button>
              <span className="text-sm font-medium">Meaningful conversation?</span>
              <span
                className="text-xs text-muted-foreground cursor-help border-b border-dashed border-muted-foreground"
                title="A real conversation that moves the needle — freight needs, rates, an opportunity, or account strategy. Not just 'what are you working on?'"
              >
                What's this?
              </span>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">
                Note {quickTouchMeaningful ? <span className="text-red-500 font-normal">*required</span> : <span className="font-normal">(optional)</span>}
              </label>
              <Input
                placeholder={quickTouchMeaningful ? "What made this conversation meaningful?" : "Quick note..."}
                value={quickTouchNote}
                onChange={e => setQuickTouchNote(e.target.value)}
                data-testid="input-quick-touch-note"
                className={quickTouchMeaningful && !quickTouchNote.trim() ? "border-red-300 dark:border-red-700" : ""}
              />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Call Vibe</label>
              <div className="flex gap-2">
                {[{ val: "positive", label: "😊 Positive", cls: "border-green-500 bg-green-50 dark:bg-green-950/40 text-green-700" }, { val: "neutral", label: "😐 Neutral", cls: "border-yellow-500 bg-yellow-50 dark:bg-yellow-950/40 text-yellow-700" }, { val: "negative", label: "😟 Negative", cls: "border-red-500 bg-red-50 dark:bg-red-950/40 text-red-700" }].map(s => (
                  <button
                    key={s.val}
                    type="button"
                    onClick={() => setQuickTouchSentiment(v => v === s.val ? "" : s.val)}
                    className={`flex-1 py-1 text-xs rounded border font-medium transition-colors ${quickTouchSentiment === s.val ? s.cls : "border-border bg-background text-muted-foreground hover:bg-muted"}`}
                    data-testid={`button-sentiment-${s.val}`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setQuickTouch(null)}>Cancel</Button>
            <Button
              onClick={() => logTouchMutation.mutate({ contactId: quickTouchContactId, type: quickTouchType, notes: quickTouchNote, sentiment: quickTouchSentiment, isMeaningful: quickTouchMeaningful })}
              disabled={!quickTouchContactId || logTouchMutation.isPending || (quickTouchMeaningful && !quickTouchNote.trim())}
              data-testid="button-submit-quick-touch"
            >
              Log Touch
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Quick Add Contact Dialog */}
      <Dialog open={!!quickAddContact} onOpenChange={open => { if (!open) { setQuickAddContact(null); setQuickAddName(""); setQuickAddTitle(""); setQuickAddEmail(""); setQuickAddPhone(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-4 w-4 text-emerald-600" />
              Add Contact — {quickAddContact?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <div>
              <label className="text-sm font-medium block mb-1">Full Name <span className="text-red-500">*</span></label>
              <Input
                placeholder="Jane Smith"
                value={quickAddName}
                onChange={e => setQuickAddName(e.target.value)}
                data-testid="input-quick-add-name"
                autoFocus
              />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Title</label>
              <Input
                placeholder="VP of Logistics"
                value={quickAddTitle}
                onChange={e => setQuickAddTitle(e.target.value)}
                data-testid="input-quick-add-title"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium block mb-1">Email</label>
                <Input
                  placeholder="jane@acme.com"
                  value={quickAddEmail}
                  onChange={e => setQuickAddEmail(e.target.value)}
                  data-testid="input-quick-add-email"
                />
              </div>
              <div>
                <label className="text-sm font-medium block mb-1">Phone</label>
                <Input
                  placeholder="555-000-0000"
                  value={quickAddPhone}
                  onChange={e => setQuickAddPhone(e.target.value)}
                  data-testid="input-quick-add-phone"
                />
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setQuickAddContact(null)}>Cancel</Button>
            <Button
              onClick={() => quickAddContact && addContactMutation.mutate({
                companyId: quickAddContact.id,
                name: quickAddName.trim(),
                title: quickAddTitle.trim() || undefined,
                email: quickAddEmail.trim() || undefined,
                phone: quickAddPhone.trim() || undefined,
              })}
              disabled={!quickAddName.trim() || addContactMutation.isPending}
              data-testid="button-submit-quick-add-contact"
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {addContactMutation.isPending ? "Adding..." : "Add Contact"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
