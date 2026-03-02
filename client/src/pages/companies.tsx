import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, Plus, Search, ExternalLink, ChevronRight } from "lucide-react";
import { CompanyDialog } from "@/components/company-dialog";
import type { Company } from "@shared/schema";

export default function Companies() {
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: companies, isLoading } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const filteredCompanies = companies?.filter((company) =>
    company.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    company.industry?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex flex-col gap-4 sm:gap-6 p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-companies-title">
            Companies
          </h1>
          <p className="text-muted-foreground">
            Manage your customer accounts and their org charts
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)} data-testid="button-add-company">
          <Plus className="h-4 w-4 mr-2" />
          Add Company
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search companies..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
          data-testid="input-search-companies"
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
          {filteredCompanies.map((company) => (
            <Link key={company.id} href={`/companies/${company.id}`}>
              <Card className="hover-elevate cursor-pointer h-full" data-testid={`card-company-${company.id}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <Building2 className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="font-medium truncate" data-testid={`text-company-name-${company.id}`}>
                          {company.name}
                        </h3>
                        <p className="text-sm text-muted-foreground truncate">
                          {company.industry || "No industry specified"}
                        </p>
                      </div>
                    </div>
                    <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
                  </div>
                  {company.website && (
                    <div className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
                      <ExternalLink className="h-3 w-3" />
                      <span className="truncate">{company.website}</span>
                    </div>
                  )}
                  {company.notes && (
                    <p className="mt-2 text-sm text-muted-foreground line-clamp-2">
                      {company.notes}
                    </p>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Building2 className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-medium mb-1">No companies found</h3>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              {searchQuery
                ? "Try adjusting your search query"
                : "Get started by adding your first company to build out their org chart"}
            </p>
            {!searchQuery && (
              <Button onClick={() => setDialogOpen(true)} className="mt-4" data-testid="button-add-first-company">
                <Plus className="h-4 w-4 mr-2" />
                Add Your First Company
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <CompanyDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
