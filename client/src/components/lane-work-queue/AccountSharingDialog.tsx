/**
 * Account Sharing Dialog — manage manual visibility collaborators.
 *
 * Opened from the top of the Lane Work Queue. Lists every account the current
 * user is allowed to manage (their own accounts + their direct reports' if
 * they're a manager + every account if they're an admin/director). For each
 * account they can add or remove collaborators (other org members) who get
 * read+act access to that account's freight/lanes everywhere in the app.
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Search, X, UserPlus, Loader2, Users } from "lucide-react";

interface ManageableAccount {
  id: string;
  name: string;
  ownerId: string;
  collaborators: Array<{
    id: string;
    userId: string;
    userName: string;
    userRole: string;
  }>;
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function AccountSharingDialog({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  // Per-row "who am I about to add" state, keyed by companyId
  const [pendingAddUser, setPendingAddUser] = useState<Record<string, string>>({});
  // Track which mutation is in-flight so we can disable just that row
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const accountsQuery = useQuery<{ accounts: ManageableAccount[] }>({
    queryKey: ["/api/account-sharing/manageable"],
    queryFn: () => fetch("/api/account-sharing/manageable").then(r => r.json()),
    enabled: open,
  });

  const teamQuery = useQuery<TeamMember[]>({
    queryKey: ["/api/team-members"],
    queryFn: () => fetch("/api/team-members").then(r => r.json()),
    enabled: open,
  });

  const addMutation = useMutation({
    mutationFn: async ({ companyId, userId }: { companyId: string; userId: string }) => {
      setBusyKey(`add:${companyId}:${userId}`);
      const r = await apiRequest("POST", `/api/companies/${companyId}/collaborators`, { userId });
      return r.json();
    },
    onSuccess: (_, vars) => {
      setPendingAddUser(prev => ({ ...prev, [vars.companyId]: "" }));
      queryClient.invalidateQueries({ queryKey: ["/api/account-sharing/manageable"] });
      queryClient.invalidateQueries({ queryKey: ["/api/my-procurement"] });
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: "Collaborator added" });
    },
    onError: (e: any) => {
      toast({ title: "Could not add collaborator", description: e?.message ?? "", variant: "destructive" });
    },
    onSettled: () => setBusyKey(null),
  });

  const removeMutation = useMutation({
    mutationFn: async ({ companyId, userId }: { companyId: string; userId: string }) => {
      setBusyKey(`remove:${companyId}:${userId}`);
      const r = await apiRequest("DELETE", `/api/companies/${companyId}/collaborators/${userId}`);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/account-sharing/manageable"] });
      queryClient.invalidateQueries({ queryKey: ["/api/my-procurement"] });
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: "Collaborator removed" });
    },
    onError: (e: any) => {
      toast({ title: "Could not remove collaborator", description: e?.message ?? "", variant: "destructive" });
    },
    onSettled: () => setBusyKey(null),
  });

  const accounts = accountsQuery.data?.accounts ?? [];
  const team = teamQuery.data ?? [];
  const teamById = useMemo(() => new Map(team.map(m => [m.id, m])), [team]);

  const filteredAccounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter(a => a.name.toLowerCase().includes(q));
  }, [accounts, search]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col" data-testid="dialog-account-sharing">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="w-4 h-4 text-amber-500" />
            Manage Account Sharing
          </DialogTitle>
          <DialogDescription>
            Add a teammate as a collaborator on an account. Collaborators see that account's freight,
            lanes, and conversations alongside the owner. They can act on the work but can't reassign
            ownership or delete the account.
          </DialogDescription>
        </DialogHeader>

        {/* Search */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search accounts…"
            className="pl-8 h-9 text-sm"
            data-testid="input-account-search"
          />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto -mx-6 px-6">
          {accountsQuery.isLoading ? (
            <div className="space-y-2 py-2">
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : filteredAccounts.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-8" data-testid="text-no-accounts">
              {search ? `No accounts match "${search}"` : "No accounts you can share."}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filteredAccounts.map(account => {
                const ownerName = teamById.get(account.ownerId)?.name ?? "—";
                // Eligible to add: anyone in the org team list except the owner
                // and except already-added collaborators.
                const collaboratorIds = new Set(account.collaborators.map(c => c.userId));
                const candidates = team
                  .filter(m => m.id !== account.ownerId && !collaboratorIds.has(m.id))
                  .sort((a, b) => a.name.localeCompare(b.name));
                const pending = pendingAddUser[account.id] ?? "";
                return (
                  <div
                    key={account.id}
                    className="py-3 first:pt-0"
                    data-testid={`row-account-${account.id}`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div>
                        <div className="text-sm font-medium text-foreground" data-testid={`text-account-name-${account.id}`}>
                          {account.name}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          Owner: {ownerName}
                        </div>
                      </div>
                    </div>

                    {/* Existing collaborators */}
                    {account.collaborators.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {account.collaborators.map(c => {
                          const removeKey = `remove:${account.id}:${c.userId}`;
                          return (
                            <Badge
                              key={c.id}
                              variant="secondary"
                              className="gap-1 pl-2 pr-1 py-0.5"
                              data-testid={`badge-collaborator-${account.id}-${c.userId}`}
                            >
                              {c.userName}
                              <span className="text-[10px] text-muted-foreground">· {c.userRole}</span>
                              <button
                                type="button"
                                onClick={() => removeMutation.mutate({ companyId: account.id, userId: c.userId })}
                                disabled={busyKey === removeKey}
                                className="hover:bg-destructive/20 rounded p-0.5 ml-0.5 disabled:opacity-50"
                                aria-label={`Remove ${c.userName}`}
                                data-testid={`button-remove-collaborator-${account.id}-${c.userId}`}
                              >
                                {busyKey === removeKey
                                  ? <Loader2 className="w-3 h-3 animate-spin" />
                                  : <X className="w-3 h-3" />}
                              </button>
                            </Badge>
                          );
                        })}
                      </div>
                    )}

                    {/* Add collaborator */}
                    {candidates.length > 0 ? (
                      <div className="flex items-center gap-2">
                        <Select
                          value={pending}
                          onValueChange={(v) => setPendingAddUser(prev => ({ ...prev, [account.id]: v }))}
                        >
                          <SelectTrigger
                            className="h-8 text-xs flex-1 max-w-[280px]"
                            data-testid={`select-add-collaborator-${account.id}`}
                          >
                            <SelectValue placeholder="Add a teammate…" />
                          </SelectTrigger>
                          <SelectContent>
                            {candidates.map(c => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name} <span className="text-muted-foreground">· {c.role}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs gap-1"
                          disabled={!pending || busyKey === `add:${account.id}:${pending}`}
                          onClick={() => addMutation.mutate({ companyId: account.id, userId: pending })}
                          data-testid={`button-add-collaborator-${account.id}`}
                        >
                          {busyKey === `add:${account.id}:${pending}`
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <UserPlus className="w-3.5 h-3.5" />}
                          Add
                        </Button>
                      </div>
                    ) : (
                      <div className="text-[11px] text-muted-foreground italic">
                        Everyone on the team already has access to this account.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
