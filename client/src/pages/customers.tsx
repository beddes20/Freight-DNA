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
} from "lucide-react";
import { CompanyDialog } from "@/components/company-dialog";
import type { Company, Contact } from "@shared/schema";

export default function Customers() {
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: companies, isLoading: companiesLoading } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
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

  const filteredCompanies = companies?.filter((company) =>
    company.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    company.industry?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const isLoading = companiesLoading;

  return (
    <div className="flex flex-col gap-4 sm:gap-6 p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-customers-title">
            Customers
          </h1>
          <p className="text-muted-foreground">
            View customer org charts and manage contacts
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)} data-testid="button-add-customer">
          <Plus className="h-4 w-4 mr-2" />
          Add Customer
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search customers..."
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
      ) : filteredCompanies && filteredCompanies.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredCompanies.map((company) => {
            const contacts = contactsByCompany.get(company.id) || [];
            const openTasks = openTasksByCompany.get(company.id) || 0;
            return (
              <Link key={company.id} href={`/companies/${company.id}`}>
                <Card className="hover-elevate cursor-pointer h-full" data-testid={`card-customer-${company.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <Building2 className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                          <h3 className="font-medium truncate" data-testid={`text-customer-name-${company.id}`}>
                            {company.name}
                          </h3>
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
                      {openTasks > 0 && (
                        <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs">
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          {openTasks} lane{openTasks !== 1 ? "s" : ""} need research
                        </Badge>
                      )}
                    </div>

                    {contacts.length > 0 && (
                      <div className="mt-3 pt-3 border-t">
                        <div className="flex flex-wrap gap-1">
                          {contacts.slice(0, 3).map((c) => (
                            <Badge key={c.id} variant="secondary" className="text-xs">
                              {c.name}
                            </Badge>
                          ))}
                          {contacts.length > 3 && (
                            <Badge variant="outline" className="text-xs">
                              +{contacts.length - 3} more
                            </Badge>
                          )}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Building2 className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-medium mb-1">No customers found</h3>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              {searchQuery
                ? "Try adjusting your search query"
                : "Get started by adding your first customer to build their org chart"}
            </p>
            {!searchQuery && (
              <Button onClick={() => setDialogOpen(true)} className="mt-4" data-testid="button-add-first-customer">
                <Plus className="h-4 w-4 mr-2" />
                Add Your First Customer
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <CompanyDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
