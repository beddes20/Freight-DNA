import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { History } from "lucide-react";

type CrmHistoryEntry = { id: number; prospectId: number; field: string; oldValue: string | null; newValue: string | null; changedById: string; createdAt: string };

const TRACKED_FIELD_LABELS: Record<string, string> = {
  stage: "Stage", ownerId: "Owner", priority: "Priority", estimatedSpend: "Est. Spend",
  dealProbability: "Win Probability", followUpDate: "Follow-up Date", expectedCloseDate: "Expected Close",
  name: "Name", industry: "Industry", website: "Website", notes: "Notes",
};

export function AccountHistoryTab({ prospectId, users }: { prospectId: number; users: any[] }) {
  const userMap = useMemo(() => new Map(users.map((u: any) => [u.id, u.name ?? u.username])), [users]);

  const { data: history = [], isLoading } = useQuery<CrmHistoryEntry[]>({
    queryKey: ["/api/prospects", prospectId, "history"],
    queryFn: async () => {
      const res = await fetch(`/api/prospects/${prospectId}/history`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const [historyPage, setHistoryPage] = useState(1);
  const PAGE_SIZE = 10;

  if (isLoading) return <div className="space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>;

  if (history.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 py-6 text-center text-muted-foreground">
        <History className="h-8 w-8 opacity-30" />
        <p className="text-sm">No change history yet</p>
        <p className="text-xs">Field edits will be tracked here</p>
      </div>
    );
  }

  const sorted = [...history].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paged = sorted.slice((historyPage - 1) * PAGE_SIZE, historyPage * PAGE_SIZE);

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="text-xs">
              <TableHead className="py-2 px-3 font-semibold">Date</TableHead>
              <TableHead className="py-2 px-3 font-semibold">Field</TableHead>
              <TableHead className="py-2 px-3 font-semibold">Changed By</TableHead>
              <TableHead className="py-2 px-3 font-semibold">Old Value</TableHead>
              <TableHead className="py-2 px-3 font-semibold">New Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.map(h => (
              <TableRow key={h.id} className="text-xs" data-testid={`history-row-${h.id}`}>
                <TableCell className="py-1.5 px-3 text-muted-foreground whitespace-nowrap">
                  {new Date(h.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" })}{" "}
                  <span className="text-[10px]">{new Date(h.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
                </TableCell>
                <TableCell className="py-1.5 px-3 font-medium">{TRACKED_FIELD_LABELS[h.field] ?? h.field}</TableCell>
                <TableCell className="py-1.5 px-3 text-muted-foreground">{userMap.get(h.changedById) ?? h.changedById}</TableCell>
                <TableCell className="py-1.5 px-3 text-muted-foreground max-w-[100px] truncate" title={h.oldValue ?? ""}>{h.oldValue ?? <span className="italic opacity-50">—</span>}</TableCell>
                <TableCell className="py-1.5 px-3 font-medium max-w-[100px] truncate" title={h.newValue ?? ""}>{h.newValue ?? <span className="italic opacity-50">(cleared)</span>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
          <span>{sorted.length} changes total</span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={historyPage <= 1} onClick={() => setHistoryPage(p => p - 1)} data-testid="history-prev-page">← Prev</Button>
            <span>Page {historyPage} of {totalPages}</span>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={historyPage >= totalPages} onClick={() => setHistoryPage(p => p + 1)} data-testid="history-next-page">Next →</Button>
          </div>
        </div>
      )}
    </div>
  );
}
