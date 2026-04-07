import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { EnrichedProspect } from "../types";

interface AccountsSectionProps {
  prospects: EnrichedProspect[];
  isLoading: boolean;
  onSelectProspect: (p: EnrichedProspect) => void;
}

export function AccountsSection({ prospects, isLoading, onSelectProspect }: AccountsSectionProps) {
  const converted = prospects.filter(p => p.convertedToCompanyId);

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto space-y-4">
        <div>
          <h2 className="text-lg font-bold">Converted Accounts</h2>
          <p className="text-sm text-muted-foreground mt-0.5">Prospects that have been converted to active customer accounts.</p>
        </div>
        {isLoading ? (
          <div className="space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="text-xs py-2">Account</TableHead>
                  <TableHead className="text-xs py-2">Owner</TableHead>
                  <TableHead className="text-xs py-2">Est. Spend</TableHead>
                  <TableHead className="text-xs py-2">Converted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {converted.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground text-sm py-8">
                      No accounts converted yet. Accounts converted from Pipeline will appear here.
                    </TableCell>
                  </TableRow>
                )}
                {converted.map(p => (
                  <TableRow key={p.id} className="cursor-pointer hover:bg-muted/30" onClick={() => onSelectProspect(p)} data-testid={`accounts-row-${p.id}`}>
                    <TableCell className="py-2">
                      <p className="font-medium text-sm">{p.name}</p>
                      {p.industry && <p className="text-xs text-muted-foreground">{p.industry}</p>}
                    </TableCell>
                    <TableCell className="py-2 text-xs text-muted-foreground">{p.ownerName ?? "—"}</TableCell>
                    <TableCell className="py-2 text-xs">{p.estimatedSpend ? `$${p.estimatedSpend}/mo` : "—"}</TableCell>
                    <TableCell className="py-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="text-[10px] border-emerald-500 text-emerald-600 dark:text-emerald-400">Converted</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
