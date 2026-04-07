import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle, XCircle, ShieldCheck, Loader2 } from "lucide-react";
import { daysAgo } from "../utils";
import type { EnrichedProspect } from "../types";

type OwnershipRequest = {
  id: number; prospectId: number; requesterId: string; currentOwnerId: string;
  status: string; reason?: string | null; adminNote?: string | null; createdAt: string;
};

export function OwnershipRequestsAdminPanel({ onClose, users, prospects: allProspects }: { onClose: () => void; users: any[]; prospects: EnrichedProspect[] }) {
  const { toast } = useToast();
  const userMap = useMemo(() => new Map(users.map((u: any) => [u.id, u.name ?? u.username])), [users]);
  const prospectMap = useMemo(() => new Map(allProspects.map(p => [p.id, p.name])), [allProspects]);
  const [denyDialogReqId, setDenyDialogReqId] = useState<number | null>(null);
  const [denyReason, setDenyReason] = useState("");

  const { data: requests = [], isLoading, refetch } = useQuery<OwnershipRequest[]>({
    queryKey: ["/api/launchpad/ownership-requests"],
    queryFn: async () => {
      const res = await fetch("/api/launchpad/ownership-requests", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const pending = requests.filter(r => r.status === "pending");

  const reviewMutation = useMutation({
    mutationFn: ({ id, status, adminNote }: { id: number; status: string; adminNote?: string }) =>
      apiRequest("PATCH", `/api/launchpad/ownership-requests/${id}/review`, { status, adminNote }).then(r => r.json()),
    onSuccess: () => { refetch(); toast({ title: "Request reviewed" }); },
    onError: () => toast({ title: "Failed to review request", variant: "destructive" }),
  });

  return (
    <>
      <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Account Ownership Requests</DialogTitle></DialogHeader>

          {isLoading ? (
            <div className="space-y-2">{[1, 2].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
          ) : pending.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
              <ShieldCheck className="h-8 w-8 opacity-30" />
              <p className="text-sm">No pending ownership requests</p>
            </div>
          ) : (
            <div className="space-y-3">
              {pending.map(r => (
                <div key={r.id} className="border rounded-lg p-3 space-y-2" data-testid={`ownership-req-${r.id}`}>
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <p className="font-semibold text-sm">{prospectMap.get(r.prospectId) ?? `Account #${r.prospectId}`}</p>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium">{userMap.get(r.requesterId) ?? r.requesterId}</span> wants to take over from <span className="font-medium">{userMap.get(r.currentOwnerId) ?? r.currentOwnerId}</span>
                      </p>
                      {r.reason && <p className="text-xs mt-1 italic text-foreground/70">"{r.reason}"</p>}
                    </div>
                    <span className="text-[10px] text-muted-foreground">{daysAgo(r.createdAt) === 0 ? "Today" : `${daysAgo(r.createdAt)}d ago`}</span>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white gap-1" onClick={() => reviewMutation.mutate({ id: r.id, status: "approved" })} data-testid={`button-approve-${r.id}`}>
                      <CheckCircle className="h-3 w-3" />Approve
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-red-600 border-red-300" onClick={() => { setDenyDialogReqId(r.id); setDenyReason(""); }} data-testid={`button-deny-${r.id}`}>
                      <XCircle className="h-3 w-3" />Deny
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {requests.filter(r => r.status !== "pending").length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Reviewed</p>
              <div className="space-y-2">
                {requests.filter(r => r.status !== "pending").slice(-5).map(r => (
                  <div key={r.id} className="flex items-center gap-2 text-xs text-muted-foreground p-2 rounded-md bg-muted/30">
                    {r.status === "approved" ? <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" /> : <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />}
                    <span><span className="font-medium text-foreground">{userMap.get(r.requesterId)}</span> → <span className="font-medium text-foreground">{prospectMap.get(r.prospectId) ?? "Account"}</span> — <span className="capitalize">{r.status}</span></span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {denyDialogReqId !== null && (
        <Dialog open onOpenChange={v => { if (!v) setDenyDialogReqId(null); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Deny Ownership Request</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">Provide a reason for denying this request. The requester will be notified.</p>
            <Textarea value={denyReason} onChange={e => setDenyReason(e.target.value)} placeholder="Reason for denial…" className="min-h-[80px]" data-testid="input-deny-reason" />
            <DialogFooter>
              <Button variant="outline" onClick={() => setDenyDialogReqId(null)}>Cancel</Button>
              <Button
                variant="destructive"
                disabled={!denyReason.trim() || reviewMutation.isPending}
                onClick={() => { reviewMutation.mutate({ id: denyDialogReqId, status: "denied", adminNote: denyReason.trim() }); setDenyDialogReqId(null); }}
                data-testid="button-confirm-deny"
              >
                {reviewMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Confirm Deny
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
