import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ShieldCheck, Loader2 } from "lucide-react";
import type { EnrichedProspect } from "../types";

export function AdminReassignOwnerSection({ prospect, users, currentUser }: { prospect: EnrichedProspect; users: any[]; currentUser: any }) {
  const { toast } = useToast();
  const [newOwnerId, setNewOwnerId] = useState("");
  const salesUsers = users.filter(u => ["sales", "sales_director", "admin", "national_account_manager", "account_manager"].includes(u.role));

  const reassignMutation = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/prospects/${prospect.id}/owner`, { newOwnerId }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prospects", prospect.id, "history"] });
      toast({ title: "Owner reassigned" });
      setNewOwnerId("");
    },
    onError: () => toast({ title: "Failed to reassign owner", variant: "destructive" }),
  });

  if (!["admin", "sales_director", "director"].includes(currentUser.role)) return null;

  return (
    <div className="border rounded-lg p-3 space-y-2 bg-muted/20">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <ShieldCheck className="h-3.5 w-3.5" /> Admin: Reassign Owner
      </p>
      <div className="flex gap-2">
        <Select value={newOwnerId} onValueChange={setNewOwnerId}>
          <SelectTrigger className="h-7 text-xs flex-1" data-testid="select-reassign-owner">
            <SelectValue placeholder="Select new owner…" />
          </SelectTrigger>
          <SelectContent>
            {salesUsers.filter(u => u.id !== prospect.ownerId).sort((a, b) => (a.name ?? a.username).localeCompare(b.name ?? b.username)).map(u => (
              <SelectItem key={u.id} value={u.id} className="text-xs">{u.name ?? u.username} ({(u.role ?? "").replace(/_/g, " ")})</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={!newOwnerId || reassignMutation.isPending}
          onClick={() => reassignMutation.mutate()}
          data-testid="button-reassign-owner"
        >
          {reassignMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Assign"}
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">Current owner: <span className="font-medium text-foreground">{prospect.ownerName ?? prospect.ownerId}</span></p>
    </div>
  );
}
