import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
  TruckIcon,
  AlertTriangle,
  Archive,
  ArchiveX,
} from "lucide-react";
import { CompanyDialog } from "@/components/company-dialog";
import type { Company, Contact } from "@shared/schema";

export default function Customers() {
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

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

  const activeList = companies
    ?.filter((company) =>
      company.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      company.industry?.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const archivedList = archivedCompanies
    ?.filter((company) =>
      company.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      company.industry?.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const displayList = showArchived ? archivedList : activeList;
  const isLoading = showArchived ? archivedLoading : companiesLoading;

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

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={showArchived ? "Search archived..." : "Search customers..."}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
          data-testid="input-search-customers"
        />
      </div>

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
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16">
          {showArchived ? (
            <>
              <Archive className="h-12 w-12 text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground text-center">No archived accounts</p>
              <p className="text-sm text-muted-foreground/70 text-center mt-1">
                Accounts you archive will appear here
              </p>
            </>
          ) : (
            <>
              <Building2 className="h-12 w-12 text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground text-center">
                {searchQuery ? "No customers match your search" : "No customers yet"}
              </p>
              {!searchQuery && (
                <Button className="mt-4" onClick={() => setDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add First Customer
                </Button>
              )}
            </>
          )}
        </div>
      )}

      <CompanyDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
