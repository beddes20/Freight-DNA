import { Link } from "wouter";
import { Clock, Building2, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { RecentlyVisitedEntry } from "@/hooks/use-recently-visited";

function MomentumBadge({ label }: { label?: string }) {
  if (!label) return null;
  const lower = label.toLowerCase();
  let cls = "text-[10px] px-1.5 py-0.5 rounded-full font-medium border-0 ";
  if (lower.includes("up") || lower.includes("rising") || lower.includes("growing")) {
    cls += "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
  } else if (lower.includes("down") || lower.includes("risk") || lower.includes("declining")) {
    cls += "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
  } else {
    cls += "bg-muted text-muted-foreground";
  }
  return <Badge className={cls}>{label}</Badge>;
}

interface RecentlyVisitedPortletProps {
  entries: RecentlyVisitedEntry[];
}

export function RecentlyVisitedPortlet({ entries }: RecentlyVisitedPortletProps) {
  return (
    <Card data-testid="portlet-recently-visited">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Recently Visited
          {entries.length > 0 && (
            <Badge variant="secondary" className="ml-auto text-xs">{entries.length}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <Building2 className="h-8 w-8 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No recently visited accounts yet.</p>
            <p className="text-xs text-muted-foreground/70">Visit an account page and it will appear here.</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {entries.map((entry) => (
              <Link key={entry.companyId} href={`/companies/${entry.companyId}`} data-testid={`recently-visited-${entry.companyId}`}>
                <div className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50 transition-colors cursor-pointer group">
                  <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="flex-1 text-sm font-medium truncate group-hover:text-foreground">{entry.name}</span>
                  {entry.momentumLabel && <MomentumBadge label={entry.momentumLabel} />}
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
