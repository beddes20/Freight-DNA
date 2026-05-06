import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trophy, Loader2 } from "lucide-react";
import type { EnrichedProspect } from "../types";

export function ConvertDialog({ prospect, onClose, users }: { prospect: EnrichedProspect; onClose: () => void; users: any[] }) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [namId, setNamId] = useState("");
  const nams = users.filter(u => ["national_account_manager", "account_manager"].includes(u.role));

  const mutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/prospects/${prospect.id}/convert`, { assignedNamId: namId || null })).json(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      toast({ title: `${prospect.name} converted to customer!` });
      onClose();
      if (data.company?.id) navigate(`/companies/${data.company.id}`);
    },
    onError: () => toast({ title: "Conversion failed", variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Trophy className="h-5 w-5 text-emerald-500" /> Convert to Customer</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <p className="text-sm text-muted-foreground"><strong className="text-foreground">{prospect.name}</strong> will become a full customer account in the CRM.</p>
          <div>
            <Label>Assign NAM (optional)</Label>
            <Select value={namId} onValueChange={setNamId}>
              <SelectTrigger className="mt-1" data-testid="select-convert-nam"><SelectValue placeholder="Select a NAM or AM…" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No assignment yet</SelectItem>
                {nams.map(u => <SelectItem key={u.id} value={u.id}>{u.name} ({u.role.replace(/_/g, " ")})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-convert-cancel">Cancel</Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => mutation.mutate()} disabled={mutation.isPending} data-testid="button-convert-confirm">
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trophy className="h-4 w-4 mr-2" />} Convert to Customer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
