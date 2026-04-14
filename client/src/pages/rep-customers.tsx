import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useLocation, useSearch } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Building2,
  ChevronRight,
  Search,
  ArrowLeft,
  UserCircle,
  ShieldCheck,
  Users,
  Network,
  AlertTriangle,
  Package,
  DollarSign,
  Percent,
} from "lucide-react";
import { useState, useEffect } from "react";
import type { Company, Contact, User } from "@shared/schema";
import { matchRepName, fmtMoney } from "@/lib/rep-utils";

type SafeUser = Omit<User, "password">;

type PeriodOption = "current" | "last" | "ytd";

interface AccountSummaryRow {
  customerName: string;
  totalLoads: number;
  spotLoads: number;
  totalMargin: number;
  totalRevenue?: number;
  repName?: string;
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  director: "Director",
  national_account_manager: "National Account Manager",
  account_manager: "Account Manager",
  logistics_manager: "Logistics Manager",
  logistics_coordinator: "Logistics Coordinator",
  sales: "Sales",
  sales_director: "Sales Director",
};

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  director: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  national_account_manager: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  account_manager: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  logistics_manager: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  logistics_coordinator: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
};

type FinMatch = { totalLoads: number; spotLoads: number; totalMargin: number; totalRevenue: number };

function matchFinancials(name: string, financialAlias: string | null | undefined, rows: AccountSummaryRow[]): FinMatch | null {
  if (!rows.length) return null;

  let matched: AccountSummaryRow[] = [];

  // 1. financialAlias exact code prefix (e.g. "GMCCPOMI" matches "GMCCPOMI - General Motors…")
  if (financialAlias) {
    const aliases = financialAlias.split(",").map(a => a.trim().toLowerCase()).filter(Boolean);
    for (const alias of aliases) {
      const hits = rows.filter(r => {
        const cn = r.customerName.toLowerCase();
        return cn === alias || cn.startsWith(alias + " ") || cn.startsWith(alias + "-");
      });
      matched.push(...hits);
    }
  }

  // 2. Fall back to display name matching
  if (matched.length === 0) {
    const lower = name.toLowerCase();
    const exact = rows.filter(r => r.customerName.toLowerCase() === lower);
    if (exact.length > 0) {
      matched = exact;
    } else if (name.length >= 5) {
      matched = rows.filter(r =>
        r.customerName.toLowerCase().includes(lower) ||
        lower.includes(r.customerName.toLowerCase())
      );
    }
  }

  if (matched.length === 0) return null;

  // Aggregate in case multiple rows match (multi-alias or split entries)
  return matched.reduce<FinMatch>(
    (acc, r) => ({
      totalLoads: acc.totalLoads + r.totalLoads,
      spotLoads: acc.spotLoads + (r.spotLoads ?? 0),
      totalMargin: acc.totalMargin + r.totalMargin,
      totalRevenue: acc.totalRevenue + (r.totalRevenue ?? 0),
    }),
    { totalLoads: 0, spotLoads: 0, totalMargin: 0, totalRevenue: 0 }
  );
}

function getPeriodLabel(period: PeriodOption): string {
  const now = new Date();
  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  if (period === "current") return `${monthNames[now.getMonth()]} ${now.getFullYear()}`;
  if (period === "last") {
    const idx = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
    const yr = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    return `${monthNames[idx]} ${yr}`;
  }
  return `YTD ${now.getFullYear()}`;
}

export default function RepCustomers() {
  const { userId } = useParams<{ userId: string }>();
  const [, navigate] = useLocation();
  const search = useSearch();
  const urlPeriod = new URLSearchParams(search).get("period") as PeriodOption | null;
  const [searchQuery, setSearchQuery] = useState("");
  const [period, setPeriod] = useState<PeriodOption>(urlPeriod || "current");

  useEffect(() => {
    if (urlPeriod && urlPeriod !== period) setPeriod(urlPeriod);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlPeriod]);

  const { data: allUsers = [], isLoading: usersLoading } = useQuery<SafeUser[]>({
    queryKey: ["/api/users"],
  });

  const { data: companies = [], isLoading: companiesLoading } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const { data: allContacts = [] } = useQuery<Contact[]>({
    queryKey: ["/api/contacts"],
  });

  const { data: researchTasks = [] } = useQuery<any[]>({
    queryKey: ["/api/research-tasks"],
  });

  const { data: accountSummary = [] } = useQuery<AccountSummaryRow[]>({
    queryKey: ["/api/financials/account-summary", period],
    queryFn: async () => {
      const res = await fetch(`/api/financials/account-summary?period=${period}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const rep = allUsers.find((u) => u.id === userId);
  const isSalesRep = rep?.role === "sales" || rep?.role === "sales_director";

  const { data: salespersonAccounts = [] } = useQuery<AccountSummaryRow[]>({
    queryKey: ["/api/financials/salesperson-accounts", period, userId],
    queryFn: async () => {
      if (!rep) return [];
      const params = new URLSearchParams({ period });
      if ((rep as any).financialRepId) params.set("repId", (rep as any).financialRepId);
      params.set("repName", rep.name);
      const res = await fetch(`/api/financials/salesperson-accounts?${params}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: isSalesRep && !!rep,
  });
  const directReports = allUsers.filter((u) => u.managerId === userId).sort((a, b) => a.name.localeCompare(b.name));

  const repCompanies = companies.filter((c) => c.assignedTo === userId).sort((a, b) => a.name.localeCompare(b.name));
  const filtered = repCompanies.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const contactsByCompany = new Map<string, Contact[]>();
  allContacts.forEach((c) => {
    const list = contactsByCompany.get(c.companyId) || [];
    list.push(c);
    contactsByCompany.set(c.companyId, list);
  });

  const openTasksByCompany = new Map<string, number>();
  researchTasks.forEach((t) => {
    if (t.status === "open") {
      openTasksByCompany.set(t.companyId, (openTasksByCompany.get(t.companyId) || 0) + 1);
    }
  });

  // Filter account summary rows that belong to this rep
  const repFinancialRows = rep ? accountSummary.filter(r => {
    if (!r.repName) return false;
    const repNameLower = r.repName.toLowerCase().trim();
    return (rep.financialRepId && rep.financialRepId.toLowerCase() === repNameLower) ||
      matchRepName(r.repName, rep.name);
  }) : [];

  const isLoading = usersLoading || companiesLoading;

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 p-4 sm:p-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!rep) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-12 text-muted-foreground">
        <Users className="h-12 w-12 opacity-40" />
        <p className="text-lg font-medium">Rep not found</p>
        <Link href="/" className="text-primary hover:underline text-sm">Back to Dashboard</Link>
      </div>
    );
  }

  const initials = rep.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(`/team-performance?period=${period}`)}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          data-testid="button-back-team-performance"
        >
          <ArrowLeft className="h-4 w-4" />
          Team Performance
        </button>
      </div>

      <div className="rounded-xl p-6 text-white" style={{ background: "#0d0d0d", border: "1px solid #1f1f1f" }}>
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-white font-bold text-xl" style={{ background: "rgba(255,180,0,0.12)", border: "1px solid rgba(255,180,0,0.25)" }}>
            {initials}
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold" data-testid="text-rep-name">{rep.name}</h1>
            <p className="text-white/60 text-sm mt-0.5">{rep.username}</p>
            <div className="mt-2 flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-medium text-white">
                {rep.role === "director" || rep.role === "national_account_manager" || rep.role === "sales" ? (
                  <ShieldCheck className="h-3 w-3" />
                ) : (
                  <UserCircle className="h-3 w-3" />
                )}
                {ROLE_LABELS[rep.role] || rep.role}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-medium text-white">
                <Building2 className="h-3 w-3" />
                {isSalesRep ? salespersonAccounts.length : repCompanies.length} {(isSalesRep ? salespersonAccounts.length : repCompanies.length) === 1 ? "account" : "accounts"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {directReports.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
            <Users className="h-4 w-4" />
            Direct Reports
          </h2>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {directReports.map((report) => {
              const reportCompanyCount = companies.filter((c) => c.assignedTo === report.id).length;
              const reportInitials = report.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
              return (
                <Link
                  key={report.id}
                  href={`/reps/${report.id}?period=${period}`}
                  className="flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/40 hover:bg-muted/50 hover:shadow-sm transition-all group cursor-pointer"
                  data-testid={`card-report-${report.id}`}
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-100 to-green-100 dark:from-blue-900/40 dark:to-green-900/40 text-blue-700 dark:text-blue-300 font-semibold text-sm">
                    {reportInitials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate group-hover:text-primary transition-colors">{report.name}</p>
                    <p className="text-xs text-muted-foreground">{reportCompanyCount} {reportCompanyCount === 1 ? "account" : "accounts"}</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {isSalesRep && (
        <div>
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Network className="h-4 w-4" />
              Financial Accounts ({salespersonAccounts.length})
            </h2>
            <Select value={period} onValueChange={(v) => setPeriod(v as PeriodOption)}>
              <SelectTrigger className="h-8 w-40 text-xs" data-testid="select-period-sales">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">This Month</SelectItem>
                <SelectItem value="last">Last Month</SelectItem>
                <SelectItem value="ytd">Year to Date</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {salespersonAccounts.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Building2 className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p className="text-sm font-medium">No financial data for this period</p>
              <p className="text-xs mt-1">Check that Financial Rep ID matches the Salesperson column in the Excel upload</p>
            </div>
          ) : (
            <div className="grid gap-2">
              {salespersonAccounts.map((acct) => {
                const marginPct = acct.totalRevenue && acct.totalRevenue > 0
                  ? (acct.totalMargin / acct.totalRevenue) * 100
                  : null;
                return (
                  <div
                    key={acct.customerName}
                    className="flex flex-col p-4 rounded-lg border border-border bg-muted/20 gap-2"
                    data-testid={`card-salesperson-acct-${acct.customerName}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-semibold text-sm">
                        {acct.customerName.charAt(0)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-sm truncate">{acct.customerName}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap pl-[48px]">
                      <span className="inline-flex items-center gap-1 rounded-md bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300">
                        <Package className="h-3 w-3" />
                        {acct.totalLoads.toLocaleString()} loads
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-md bg-green-50 dark:bg-green-900/20 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-300">
                        <DollarSign className="h-3 w-3" />
                        {fmtMoney(acct.totalMargin)} margin
                      </span>
                      {marginPct !== null && (
                        <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${marginPct < 0 ? "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300" : "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300"}`}>
                          <Percent className="h-3 w-3" />
                          {marginPct.toFixed(1)}%
                        </span>
                      )}
                      {acct.spotLoads > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-purple-50 dark:bg-purple-900/20 px-2 py-0.5 text-xs font-medium text-purple-700 dark:text-purple-300">
                          {acct.spotLoads} spot
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {!isSalesRep && <div>
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Network className="h-4 w-4" />
            Customers ({repCompanies.length})
          </h2>
          <div className="flex items-center gap-2">
            <Select value={period} onValueChange={(v) => setPeriod(v as PeriodOption)}>
              <SelectTrigger className="h-8 w-40 text-xs" data-testid="select-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">This Month</SelectItem>
                <SelectItem value="last">Last Month</SelectItem>
                <SelectItem value="ytd">Year to Date</SelectItem>
              </SelectContent>
            </Select>
            {repCompanies.length > 5 && (
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 h-8 w-40 text-sm"
                  data-testid="input-search-companies"
                />
              </div>
            )}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Building2 className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm font-medium">
              {searchQuery ? "No matching customers" : "No customers assigned"}
            </p>
          </div>
        ) : (
          <div className="grid gap-2">
            {filtered.map((company) => {
              const contacts = contactsByCompany.get(company.id) || [];
              const openTasks = openTasksByCompany.get(company.id) || 0;
              const fin = matchFinancials(company.name, company.financialAlias, repFinancialRows);
              const marginPct = fin && fin.totalRevenue && fin.totalRevenue > 0
                ? (fin.totalMargin / fin.totalRevenue) * 100
                : null;
              return (
                <Link
                  key={company.id}
                  href={`/companies/${company.id}`}
                  className="flex flex-col p-4 rounded-lg border border-border hover:border-primary/40 hover:bg-muted/50 hover:shadow-sm transition-all group cursor-pointer gap-2"
                  data-testid={`card-company-${company.id}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-semibold text-sm">
                        {company.name.charAt(0)}
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate group-hover:text-primary transition-colors">{company.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {company.industry || "No industry"} · {contacts.length} {contacts.length === 1 ? "contact" : "contacts"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      {openTasks > 0 && (
                        <Badge variant="outline" className="text-xs gap-1 text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-900/20">
                          <AlertTriangle className="h-3 w-3" />
                          {openTasks}
                        </Badge>
                      )}
                      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                    </div>
                  </div>

                  {fin && (
                    <div className="flex items-center gap-2 flex-wrap pl-[52px]">
                      <span className="inline-flex items-center gap-1 rounded-md bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300">
                        <Package className="h-3 w-3" />
                        {fin.totalLoads.toLocaleString()} loads
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-md bg-green-50 dark:bg-green-900/20 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-300">
                        <DollarSign className="h-3 w-3" />
                        {fmtMoney(fin.totalMargin)} margin
                      </span>
                      {marginPct !== null && (
                        <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${marginPct < 0 ? "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300" : "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300"}`}>
                          <Percent className="h-3 w-3" />
                          {marginPct.toFixed(1)}%
                        </span>
                      )}
                      {fin.spotLoads > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-purple-50 dark:bg-purple-900/20 px-2 py-0.5 text-xs font-medium text-purple-700 dark:text-purple-300">
                          {fin.spotLoads} spot
                        </span>
                      )}
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>}
    </div>
  );
}
