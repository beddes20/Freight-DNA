import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Inbox, Check, X, Edit3 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { HitlAction } from "@shared/schema";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-red-100 text-red-800",
  executed: "bg-emerald-200 text-emerald-900",
  edited: "bg-blue-100 text-blue-800",
};

export default function ApprovalsPage() {
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ items: HitlAction[]; counts: Record<string, number> }>({
    queryKey: ["/api/agentic/inbox", filter],
    queryFn: async () => {
      const url = filter === "all"
        ? "/api/agentic/inbox?status=pending,approved,rejected,edited,executed"
        : "/api/agentic/inbox?status=pending";
      const res = await fetch(url, { credentials: "include" });
      return res.json();
    },
  });

  const decide = useMutation({
    mutationFn: (args: { id: string; decision: string; decisionNote?: string }) =>
      apiRequest("POST", `/api/agentic/inbox/${args.id}/decision`, args).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agentic/inbox"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agentic/agents"] });
      toast({ title: "Decision recorded" });
    },
  });

  const counts = data?.counts ?? {};

  return (
    <div className="container mx-auto py-6 space-y-6" data-testid="page-approvals">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Inbox className="h-6 w-6" /> Approvals Inbox</h1>
          <p className="text-sm text-muted-foreground mt-1">Every staged agent action lands here. Approve to execute (dry-run for now), reject to teach, or edit before approving.</p>
        </div>
        <div className="flex gap-2">
          <Button variant={filter === "pending" ? "default" : "outline"} onClick={() => setFilter("pending")} data-testid="button-filter-pending">
            Pending {counts.pending ? `(${counts.pending})` : ""}
          </Button>
          <Button variant={filter === "all" ? "default" : "outline"} onClick={() => setFilter("all")} data-testid="button-filter-all">All</Button>
        </div>
      </div>

      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {(data?.items ?? []).length === 0 && !isLoading && (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">
          Inbox is clear. Run an agent loop from <strong>/agents</strong> to stage a sample action.
        </CardContent></Card>
      )}

      <div className="space-y-3">
        {(data?.items ?? []).map((it) => (
          <ApprovalCard key={it.id} item={it} onDecide={(d, note) => decide.mutate({ id: it.id, decision: d, decisionNote: note })} disabled={decide.isPending || it.status !== "pending"} />
        ))}
      </div>
    </div>
  );
}

function ApprovalCard({ item, onDecide, disabled }: { item: HitlAction; onDecide: (decision: string, note?: string) => void; disabled: boolean }) {
  const [showEdit, setShowEdit] = useState(false);
  const [note, setNote] = useState("");
  return (
    <Card data-testid={`approval-${item.id}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{item.title}</CardTitle>
            <div className="text-xs text-muted-foreground mt-1">
              {item.actionKind} · {item.adapterMode} · {new Date(item.createdAt).toLocaleString()}
            </div>
          </div>
          <Badge className={STATUS_COLORS[item.status] ?? ""}>{item.status}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {item.summary && <div className="text-sm">{item.summary}</div>}
        {item.reasoning && <div className="text-xs text-muted-foreground italic">Why: {item.reasoning}</div>}
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Payload</summary>
          <pre className="mt-2 p-2 bg-muted rounded overflow-auto">{JSON.stringify(item.payload, null, 2)}</pre>
        </details>
        {item.status === "pending" && (
          <>
            {showEdit && (
              <Textarea placeholder="Note for the agent (what to learn from this)…" value={note} onChange={(e) => setNote(e.target.value)} data-testid={`textarea-note-${item.id}`} />
            )}
            <div className="flex gap-2">
              <Button size="sm" disabled={disabled} onClick={() => onDecide("approved", note || undefined)} data-testid={`button-approve-${item.id}`}>
                <Check className="h-4 w-4 mr-1" /> Approve
              </Button>
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => setShowEdit((v) => !v)} data-testid={`button-edit-${item.id}`}>
                <Edit3 className="h-4 w-4 mr-1" /> Add note
              </Button>
              <Button size="sm" variant="destructive" disabled={disabled} onClick={() => onDecide("rejected", note || undefined)} data-testid={`button-reject-${item.id}`}>
                <X className="h-4 w-4 mr-1" /> Reject
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
