import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import {
  Building2, Users, DollarSign, ChevronRight, ShieldCheck, UserCircle,
} from "lucide-react";
import type { SafeUser } from "./types";
import type { Company, Contact } from "@shared/schema";

interface TeamDirectorySectionProps {
  isVisible: (key: string) => boolean;
  getOrder: (key: string) => number;
  canSeeTeam: boolean;
  nams: SafeUser[];
  ams: SafeUser[];
  usersLoading: boolean;
  isLoading: boolean;
  companies: Company[] | undefined;
  contacts: Contact[] | undefined;
  allUsers: SafeUser[];
}

function UserRow({ user, companies, allUsers }: { user: SafeUser; companies: Company[] | undefined; allUsers: SafeUser[] }) {
  const count = companies?.filter(c => c.assignedTo === user.id).length ?? 0;
  const initials = user.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
  const manager = user.managerId ? allUsers.find(u => u.id === user.managerId)?.name ?? null : null;
  return (
    <Link
      href={`/reps/${user.id}`}
      className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 hover:border-border border border-transparent transition-all group cursor-pointer"
      data-testid={`row-user-${user.id}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-100 to-green-100 dark:from-blue-900/40 dark:to-green-900/40 text-blue-700 dark:text-blue-300 font-semibold text-sm">
          {initials}
        </div>
        <div className="min-w-0">
          <p className="font-medium text-sm truncate group-hover:text-primary transition-colors" data-testid={`text-user-name-${user.id}`}>{user.name}</p>
          <p className="text-xs text-muted-foreground truncate">{user.username}</p>
          {manager && (
            <p className="text-xs text-muted-foreground/70 truncate">Reports to: {manager}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 ml-2">
        <div className="text-right">
          <p className="text-sm font-semibold text-blue-600 dark:text-blue-400">{count}</p>
          <p className="text-xs text-muted-foreground">{count === 1 ? "account" : "accounts"}</p>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
      </div>
    </Link>
  );
}

export function TeamDirectorySection({
  isVisible, getOrder, canSeeTeam, nams, ams, usersLoading, isLoading, companies, contacts, allUsers,
}: TeamDirectorySectionProps) {
  return (
    <div style={{ order: getOrder("team-directory") }} className={!isVisible("team-directory") ? "hidden" : ""}>
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
                {nams.map((u) => <UserRow key={u.id} user={u} companies={companies} allUsers={allUsers} />)}
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
                {ams.map((u) => <UserRow key={u.id} user={u} companies={companies} allUsers={allUsers} />)}
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
              {companies.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, 5).map((company) => {
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
    </div>
  );
}
