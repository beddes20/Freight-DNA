import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Star } from "lucide-react";
import { usePinnedCompanies } from "@/hooks/use-pinned-companies";
import { GROWTH_BAND_STYLES } from "@/components/account-growth-portlet";
import type { Company } from "@shared/schema";
import { formatCustomerName } from "@shared/laneFormatters";

type GrowthScoreRow = { companyId: string; score: number; band: string; bandLabel: string };

export function PinnedAccountsPortlet() {
  const { pinned, isLoading: pinnedLoading } = usePinnedCompanies();

  const { data: allCompanies = [] } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const { data: growthScores = [] } = useQuery<GrowthScoreRow[]>({
    queryKey: ["/api/growth-scores"],
    staleTime: 90_000,
  });
  const growthScoreMap = new Map(growthScores.map((r) => [r.companyId, r]));

  if (pinnedLoading) {
    return (
      <Card data-testid="card-pinned-accounts">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Star className="h-4 w-4 text-amber-500 fill-amber-500" />
            Pinned Accounts
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 rounded-md" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (pinned.length === 0) return null;

  const companyMap = new Map(allCompanies.map((c) => [c.id, c]));
  const pinnedCompanies = pinned.map((p) => companyMap.get(p.companyId)).filter(Boolean) as Company[];

  return (
    <Card data-testid="card-pinned-accounts">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Star className="h-4 w-4 text-amber-500 fill-amber-500" />
          Pinned Accounts
          <Badge variant="secondary" className="ml-1 font-normal">{pinnedCompanies.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {pinnedCompanies.map((company) => {
            const gs = growthScoreMap.get(company.id);
            const style = gs ? (GROWTH_BAND_STYLES[gs.band] ?? GROWTH_BAND_STYLES.stable) : null;
            return (
              <Link
                key={company.id}
                href={`/companies/${company.id}`}
                data-testid={`pinned-company-card-${company.id}`}
              >
                <div className="flex items-center justify-between rounded-md border px-3 py-2 hover:bg-muted/50 cursor-pointer transition-colors group">
                  <span className="text-sm font-medium truncate group-hover:text-primary transition-colors">{formatCustomerName(company.name)}</span>
                  {gs && style && (
                    <Badge
                      className={`ml-2 shrink-0 text-xs border ${style.bg} ${style.text} ${style.border}`}
                      data-testid={`badge-momentum-pinned-${company.id}`}
                    >
                      {gs.bandLabel}
                    </Badge>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
