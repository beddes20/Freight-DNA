import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, Users, MapPin, DollarSign, ChevronRight, TrendingUp, Target, ShieldCheck, UserCircle } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import type { Company, Contact, User } from "@shared/schema";

type SafeUser = Omit<User, "password">;

export default function Dashboard() {
  const { user: currentUser } = useAuth();

  const { data: companies, isLoading: companiesLoading } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const { data: contacts, isLoading: contactsLoading } = useQuery<Contact[]>({
    queryKey: ["/api/contacts"],
  });

  const canSeeTeam = currentUser?.role === "admin" || currentUser?.role === "national_account_manager";
  const { data: allUsers = [], isLoading: usersLoading } = useQuery<SafeUser[]>({
    queryKey: ["/api/users"],
    enabled: canSeeTeam,
  });

  const isLoading = companiesLoading || contactsLoading;

  const totalFreightSpend = contacts?.reduce((acc, c) => {
    return acc + (c.freightSpend ? parseFloat(c.freightSpend) : 0);
  }, 0) || 0;

  const uniqueRegions = new Set(
    contacts?.flatMap((c) => c.regions || []) || []
  );

  const stats = [
    {
      title: "Total Companies",
      value: companies?.length || 0,
      icon: Building2,
      description: "Active accounts",
      color: "text-blue-600 dark:text-blue-400",
      bg: "bg-blue-100 dark:bg-blue-900/30",
    },
    {
      title: "Total Contacts",
      value: contacts?.length || 0,
      icon: Users,
      description: "People tracked",
      color: "text-green-600 dark:text-green-400",
      bg: "bg-green-100 dark:bg-green-900/30",
    },
    {
      title: "Regions Covered",
      value: uniqueRegions.size,
      icon: MapPin,
      description: "Geographic coverage",
      color: "text-purple-600 dark:text-purple-400",
      bg: "bg-purple-100 dark:bg-purple-900/30",
    },
    {
      title: "Total Freight Spend",
      value: `$${(totalFreightSpend / 1000000).toFixed(1)}M`,
      icon: DollarSign,
      description: "Combined annual spend",
      color: "text-emerald-600 dark:text-emerald-400",
      bg: "bg-emerald-100 dark:bg-emerald-900/30",
    },
  ];

  const nams = allUsers.filter((u) => u.role === "national_account_manager");
  const ams = allUsers.filter((u) => u.role === "account_manager");

  const companyCountFor = (userId: string) =>
    companies?.filter((c) => c.assignedTo === userId).length ?? 0;

  const managerNameFor = (managerId: string | null) => {
    if (!managerId) return null;
    return allUsers.find((u) => u.id === managerId)?.name ?? null;
  };

  const UserRow = ({ user }: { user: SafeUser }) => {
    const count = companyCountFor(user.id);
    const initials = user.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
    const manager = managerNameFor(user.managerId);
    return (
      <div
        className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors"
        data-testid={`row-user-${user.id}`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-100 to-green-100 dark:from-blue-900/40 dark:to-green-900/40 text-blue-700 dark:text-blue-300 font-semibold text-sm">
            {initials}
          </div>
          <div className="min-w-0">
            <p className="font-medium text-sm truncate" data-testid={`text-user-name-${user.id}`}>{user.name}</p>
            <p className="text-xs text-muted-foreground truncate">{user.username}</p>
            {manager && (
              <p className="text-xs text-muted-foreground/70 truncate">Reports to: {manager}</p>
            )}
          </div>
        </div>
        <div className="shrink-0 ml-2 text-right">
          <p className="text-sm font-semibold text-blue-600 dark:text-blue-400">{count}</p>
          <p className="text-xs text-muted-foreground">{count === 1 ? "account" : "accounts"}</p>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div className="rounded-xl bg-gradient-to-r from-blue-600 to-green-600 p-6 sm:p-8 text-white">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold" data-testid="text-dashboard-title">
              Welcome back
            </h1>
            <p className="text-blue-100 mt-1 text-sm sm:text-base">
              Your transportation brokerage sales dashboard
            </p>
          </div>
          <div className="hidden sm:flex items-center gap-2 rounded-lg bg-white/15 backdrop-blur-sm px-3 py-2">
            <Target className="h-4 w-4" />
            <span className="text-sm font-medium">{companies?.length || 0} Active Accounts</span>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.title} className="overflow-hidden">
            <CardContent className="p-4 sm:p-6">
              {isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${stat.bg}`}>
                      <stat.icon className={`h-4 w-4 ${stat.color}`} />
                    </div>
                    <TrendingUp className="h-3 w-3 text-green-500" />
                  </div>
                  <div>
                    <div className="text-xl sm:text-2xl font-bold" data-testid={`text-stat-${stat.title.toLowerCase().replace(/\s/g, "-")}`}>
                      {stat.value}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {stat.description}
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              My Customers
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : companies && companies.length > 0 ? (
              <div className="space-y-2">
                {companies.slice(0, 5).map((company) => {
                  const companyContacts = contacts?.filter((c) => c.companyId === company.id) || [];
                  return (
                    <Link
                      key={company.id}
                      href={`/companies/${company.id}`}
                      className="flex items-center justify-between p-3 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all cursor-pointer group"
                      data-testid={`card-company-${company.id}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-semibold text-sm">
                          {company.name.charAt(0)}
                        </div>
                        <div>
                          <p className="font-medium text-sm">{company.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {company.industry || "No industry"} · {companyContacts.length} contacts
                          </p>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    </Link>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <Building2 className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No customers yet</p>
                <p className="text-xs">Add your first company to get started</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-green-600 dark:text-green-400" />
              Top Contacts by Freight Spend
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : contacts && contacts.length > 0 ? (
              <div className="space-y-2">
                {[...contacts]
                  .sort((a, b) => parseFloat(b.freightSpend || "0") - parseFloat(a.freightSpend || "0"))
                  .slice(0, 5)
                  .map((contact, index) => (
                    <div
                      key={contact.id}
                      className="flex items-center justify-between p-3 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all"
                      data-testid={`card-contact-${contact.id}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`flex h-9 w-9 items-center justify-center rounded-full font-semibold text-sm ${
                          index === 0 ? "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400" :
                          index === 1 ? "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400" :
                          "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                        }`}>
                          {contact.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                        </div>
                        <div>
                          <p className="font-medium text-sm">{contact.name}</p>
                          <p className="text-xs text-muted-foreground">{contact.title || "No title"}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-green-600 dark:text-green-400">
                          ${contact.freightSpend ? Number(contact.freightSpend).toLocaleString() : "0"}
                        </p>
                        <p className="text-xs text-muted-foreground">Annual</p>
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No contacts yet</p>
                <p className="text-xs">Add contacts to companies to see them here</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {canSeeTeam && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                National Account Managers
                {!usersLoading && (
                  <Badge variant="secondary" className="ml-auto font-normal">{nams.length}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {usersLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
                </div>
              ) : nams.length > 0 ? (
                <div className="space-y-1 max-h-72 overflow-y-auto">
                  {nams.map((u) => <UserRow key={u.id} user={u} />)}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <ShieldCheck className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No national account managers</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <UserCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                Account Managers
                {!usersLoading && (
                  <Badge variant="secondary" className="ml-auto font-normal">{ams.length}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {usersLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
                </div>
              ) : ams.length > 0 ? (
                <div className="space-y-1 max-h-72 overflow-y-auto">
                  {ams.map((u) => <UserRow key={u.id} user={u} />)}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <UserCircle className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No account managers</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
