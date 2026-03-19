import { useState, useMemo } from "react";
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
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CompanyDialog } from "@/components/company-dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import type { Company, Contact, User } from "@shared/schema";

type MonthBucket = { totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue?: number };
type AccountSummaryRow = {
  customerName: string;
  totalLoads: number;
  spotLoads: number;
  totalMargin: number;
  totalRevenue?: number;
  repName: string;
  byMonth?: Record<string, MonthBucket>;
};

type TouchpointSummary = Record<string, { week: number; month: number }>;

function matchFinancials(name: string, rows: AccountSummaryRow[]): AccountSummaryRow | null {
  if (!rows.length) return null;
  const lower = name.toLowerCase();
  const exact = rows.find(r => r.customerName.toLowerCase() === lower);
  if (exact) return exact;
  const sub = name.length >= 5 ? rows.find(r =>
    r.customerName.toLowerCase().includes(lower) ||
    lower.includes(r.customerName.toLowerCase())
  ) : null;
  return sub || null;
}

export default function Customers() {
  const { user: currentUser } = useAuth();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [repFilter, setRepFilter] = useState("all");
  const [industryFilter, setIndustryFilter] = useState("all");
  const [touchFilter, setTouchFilter] = useState("all");
  const [quickTouch, setQuickTouch] = useState<{ company: Company; contacts: Contact[] } | null>(null);
  const [quickTouchContactId, setQuickTouchContactId] = useState("");
  const [quickTouchType, setQuickTouchType] = useState("call");
  const [quickTouchNote, setQuickTouchNote] = useState("");

  const logTouchMutation = useMutation({
    mutationFn: ({ contactId, type, notes }: { contactId: string; type: string; notes: string }) =>
      apiRequest("POST", `/api/contacts/${contactId}/touchpoints`, { type, date: new Date().toISOString().slice(0, 10), notes }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/touchpoints/company-summary"] });
      toast({ title: "Touch logged!" });
      setQuickTouch(null);
      setQuickTouchContactId("");
      setQuickTouchType("call");
      setQuickTouchNote("");
    },
    onError: () => toast({ title: "Failed to log touch", variant: "destructive" }),
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

  const activeFiltersCount = [repFilter !== "all", industryFilter !== "all", touchFilter !== "all"].filter(Boolean).length;

  function applyFilters(list: Company[] | undefined) {
    if (!list) return [];
    return list.filter(company => {
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!company.name.toLowerCase().includes(q) && !company.industry?.toLowerCase().includes(q)) return false;
      }
      if (isAdminOrDirector && repFilter === "all" && company.assignedTo && !namAmIds.has(company.assignedTo)) return false;
      if (repFilter !== "all" && company.assignedTo !== repFilter) return false;
      if (industryFilter !== "all" && company.industry !== industryFilter) return false;
      if (touchFilter !== "all") {
        const tps = tpSummary[company.id] || { week: 0, month: 0 };
        if (touchFilter === "not_this_month" && tps.month > 0) return false;
        if (touchFilter === "not_this_week" && tps.week > 0) return false;
      }
      return true;
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  const displayList = applyFilters(showArchived ? archivedCompanies : companies);
  const isLoading = showArchived ? archivedLoading : companiesLoading;

  function clearFilters() {
    setRepFilter("all");
    setIndustryFilter("all");
    setTouchFilter("all");
  }

  return (
    <div className="flex flex-col gap-4 sm:gap-6 p-4 sm:p-6">
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
        {!isLoading && (
          <span className="text-sm text-muted-foreground ml-auto">
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
                <SelectItem value="not_this_week">Not touched this week</SelectItem>
                <SelectItem value="not_this_month">Not touched this month</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
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
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {displayList.map((company) => {
            const contacts = contactsByCompany.get(company.id) || [];
            const openTasks = openTasksByCompany.get(company.id) || 0;
            const fin = (company.financialAlias ? matchFinancials(company.financialAlias, accountSummary) : null) || matchFinancials(company.name, accountSummary);
            const tps = tpSummary[company.id] || { week: 0, month: 0 };
            return (
              <Link key={company.id} href={`/companies/${company.id}`}>
                <Card className="hover-elevate cursor-pointer h-full" data-testid={`card-customer-${company.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${company.archivedAt ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"}`}>
                          {company.archivedAt ? <Archive className="h-5 w-5" /> : <Building2 className="h-5 w-5" />}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
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
                        </div>
                      </div>
                      {contacts.length > 0 && !company.archivedAt && (
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
                                      {margin >= 1000 || margin <= -1000
                                        ? `$${(margin / 1000).toFixed(1)}k`
                                        : `$${margin.toFixed(0)}`}
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
                        {(tps.week > 0 || tps.month > 0) && (
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto">
                            <PhoneCall className="h-3 w-3" />
                            <span>{tps.week > 0 ? `${tps.week} this wk` : `${tps.month} this mo.`}</span>
                          </div>
                        )}
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
            <div>
              <label className="text-sm font-medium block mb-1">Note (optional)</label>
              <Input
                placeholder="Quick note..."
                value={quickTouchNote}
                onChange={e => setQuickTouchNote(e.target.value)}
                data-testid="input-quick-touch-note"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setQuickTouch(null)}>Cancel</Button>
            <Button
              onClick={() => logTouchMutation.mutate({ contactId: quickTouchContactId, type: quickTouchType, notes: quickTouchNote })}
              disabled={!quickTouchContactId || logTouchMutation.isPending}
              data-testid="button-submit-quick-touch"
            >
              Log Touch
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
