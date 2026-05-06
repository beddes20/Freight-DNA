import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";

export function OwnershipRequestDialog({ prospectId, onClose }: { prospectId: number; onClose: () => void }) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const mutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/prospects/${prospectId}/ownership-request`, { reason: reason.trim() || null }).then(r => r.json()),
    onSuccess: () => { toast({ title: "Ownership request submitted" }); onClose(); },
    onError: () => toast({ title: "Failed to submit request", variant: "destructive" }),
  });
  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Request Account Ownership</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Submit a request to be assigned as the owner of this account. An admin will review and approve or deny your request.</p>
        <Textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Optional: Explain why you should own this account…" className="min-h-[80px]" data-testid="input-ownership-reason" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending} data-testid="button-submit-ownership-request">
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Submit Request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
