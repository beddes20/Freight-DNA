import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
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
} from "lucide-react";
import { useState } from "react";
import type { Company, Contact, User } from "@shared/schema";

type SafeUser = Omit<User, "password">;

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  director: "Director",
  national_account_manager: "National Account Manager",
  account_manager: "Account Manager",
};

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  director: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  national_account_manager: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  account_manager: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
};

export default function RepCustomers() {
  const { userId } = useParams<{ userId: string }>();
  const [, navigate] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");

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

  const rep = allUsers.find((u) => u.id === userId);
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
          onClick={() => navigate("/")}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          data-testid="button-back-dashboard"
        >
          <ArrowLeft className="h-4 w-4" />
          Dashboard
        </button>
      </div>

      <div className="rounded-xl p-6 text-white" style={{ background: "linear-gradient(135deg, #001AB3 0%, #044ad3 60%, #2868ff 100%)" }}>
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm text-white font-bold text-xl">
            {initials}
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold" data-testid="text-rep-name">{rep.name}</h1>
            <p className="text-blue-200 text-sm mt-0.5">{rep.username}</p>
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
                {repCompanies.length} {repCompanies.length === 1 ? "account" : "accounts"}
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
                  href={`/reps/${report.id}`}
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

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Network className="h-4 w-4" />
            Customers ({repCompanies.length})
          </h2>
          {repCompanies.length > 5 && (
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8 w-48 text-sm"
                data-testid="input-search-companies"
              />
            </div>
          )}
        </div>

        {filtered.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Building2 className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm font-medium">
              {searchQuery ? "No matching customers" : "No customers assigned"}
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            {filtered.map((company) => {
              const contacts = contactsByCompany.get(company.id) || [];
              const openTasks = openTasksByCompany.get(company.id) || 0;
              return (
                <Link
                  key={company.id}
                  href={`/companies/${company.id}`}
                  className="flex items-center justify-between p-4 rounded-lg border border-border hover:border-primary/40 hover:bg-muted/50 hover:shadow-sm transition-all group cursor-pointer"
                  data-testid={`card-company-${company.id}`}
                >
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
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
