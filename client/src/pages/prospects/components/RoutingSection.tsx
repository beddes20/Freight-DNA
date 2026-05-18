import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Inbox, Mail, UserPlus, UserCheck, Trash2, Loader2, ShieldAlert } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

// Launchpad L1 — Needs Routing
// Rep/manager surface for `companies` rows auto-created by inbound email
// (is_email_derived=true) that still have no owner. Reuses the existing
// `GET /api/companies?includeEmailDerived=true` read endpoint and the
// existing PATCH /api/companies/:id/owner and POST /api/companies/:id/archive
// write endpoints — no new backend routes added.

type EmailDerivedCompany = {
  id: string;
  name: string;
  isEmailDerived?: boolean;
  emailDerivedAt?: string | null;
  emailDerivedSeedMessageId?: string | null;
  ownerRepId?: string | null;
  assignedTo?: string | null;
  salesPersonId?: string | null;
  archivedAt?: string | null;
};

type UserRow = { id: string; name?: string | null; username?: string | null; role?: string | null };

// L1 scope: admins only. The existing GET /api/companies route applies
// getVisibleCompanyIds(currentUser) (server/auth.ts), which filters out every
// unowned company for non-admin roles — so the queue would be empty for
// directors/NAMs/sales_directors today. The admin email-derived console
// (/api/admin/email-derived-companies) is admin-gated for the same reason.
// Widening visibility for unowned rows requires a deliberate change to
// getVisibleCompanyIds (CQ, dashboards, NBA all read it) and is scoped to a
// later phase. Manager surfacing lands as L1.1 once that change earns its
// own contract.

function formatAge(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const hours = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function RoutingSection() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";

  const { data: companies = [], isLoading, isError } = useQuery<EmailDerivedCompany[]>({
    queryKey: ["/api/companies", { includeEmailDerived: true }],
    queryFn: async () => {
      const r = await fetch("/api/companies?includeEmailDerived=true", { credentials: "include" });
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    enabled: isAdmin,
    refetchInterval: 60_000,
  });

  const { data: allUsers = [] } = useQuery<UserRow[]>({ queryKey: ["/api/users"], enabled: isAdmin });

  // Canonical "no owner" check mirrors getCanonicalCompanyOwnerId() in
  // server/lib/companyOwner.ts: ownerRepId ?? assignedTo ?? salesPersonId.
  // Any of the three set means the row has an owner and should not appear here.
  const inboxRows = useMemo(() => {
    return companies
      .filter(c => c.isEmailDerived === true)
      .filter(c => !c.ownerRepId && !c.assignedTo && !c.salesPersonId)
      .filter(c => !c.archivedAt)
      .sort((a, b) => {
        const at = a.emailDerivedAt ? new Date(a.emailDerivedAt).getTime() : 0;
        const bt = b.emailDerivedAt ? new Date(b.emailDerivedAt).getTime() : 0;
        return bt - at;
      });
  }, [companies]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
  };

  const claimMutation = useMutation({
    mutationFn: async (companyId: string) => {
      if (!user) throw new Error("not signed in");
      return apiRequest("PATCH", `/api/companies/${companyId}/owner`, { ownerRepId: user.id });
    },
    onSuccess: () => {
      toast({ title: "Claimed", description: "You now own this account." });
      invalidate();
    },
    onError: (e: any) => toast({
      title: "Couldn't claim",
      description: e?.message ?? "Please try again.",
      variant: "destructive",
    }),
  });

  const assignMutation = useMutation({
    mutationFn: async ({ companyId, repId }: { companyId: string; repId: string }) => {
      return apiRequest("PATCH", `/api/companies/${companyId}/owner`, { ownerRepId: repId });
    },
    onSuccess: () => {
      toast({ title: "Assigned" });
      invalidate();
      setAssignTarget(null);
    },
    onError: (e: any) => toast({
      title: "Couldn't assign",
      description: e?.message ?? "Please try again.",
      variant: "destructive",
    }),
  });

  const archiveMutation = useMutation({
    mutationFn: async (companyId: string) => apiRequest("POST", `/api/companies/${companyId}/archive`, {}),
    onSuccess: () => {
      toast({ title: "Marked as noise", description: "Account archived." });
      invalidate();
      setArchiveTarget(null);
    },
    onError: (e: any) => toast({
      title: "Couldn't archive",
      description: e?.message ?? "Please try again.",
      variant: "destructive",
    }),
  });

  const [assignTarget, setAssignTarget] = useState<EmailDerivedCompany | null>(null);
  const [assignRepId, setAssignRepId] = useState<string>("");
  const [archiveTarget, setArchiveTarget] = useState<EmailDerivedCompany | null>(null);

  const repOptions = useMemo(
    () => allUsers
      .filter(u => (u.role === "sales" || u.role === "account_manager" || u.role === "national_account_manager"))
      .sort((a, b) => (a.name ?? a.username ?? "").localeCompare(b.name ?? b.username ?? "")),
    [allUsers],
  );

  return (
    <div className="flex-1 overflow-auto p-4" data-testid="section-routing">
      <div className="mb-4 flex items-center gap-3">
        <Inbox className="h-5 w-5 text-blue-600 dark:text-blue-400" />
        <div className="flex-1">
          <h2 className="text-base font-bold">Needs Routing</h2>
          <p className="text-xs text-muted-foreground">
            Accounts auto-created from inbound email that don't have an owner yet. Claim them as your prospect,
            assign to a rep, or mark as noise.
          </p>
        </div>
        {!isLoading && (
          <Badge variant="secondary" data-testid="badge-routing-count">
            {inboxRows.length} unrouted
          </Badge>
        )}
      </div>

      {!isAdmin && (
        <div className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm text-amber-900 dark:text-amber-200 flex items-start gap-2" data-testid="banner-routing-admin-only">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            The routing queue is admin-only in this release. Unowned accounts auto-created from
            email are invisible to other roles by the account-visibility rules; expanding access
            for managers is a planned follow-up.
          </span>
        </div>
      )}

      {isError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" data-testid="text-routing-error">
          Couldn't load the routing inbox. Refresh to try again.
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : inboxRows.length === 0 ? (
        <div className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground" data-testid="empty-routing">
          <Inbox className="h-8 w-8 mx-auto mb-2 opacity-50" />
          All clear — nothing waiting for routing right now.
        </div>
      ) : (
        <div className="space-y-2">
          {inboxRows.map(c => (
            <div
              key={c.id}
              className="flex items-center gap-3 rounded-md border bg-card p-3 hover:bg-muted/40 transition-colors"
              data-testid={`routing-row-${c.id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium truncate" data-testid={`text-routing-name-${c.id}`}>{c.name}</p>
                  <Badge variant="outline" className="text-[10px] gap-1 border-blue-200 text-blue-700 dark:border-blue-800 dark:text-blue-300">
                    <Mail className="h-3 w-3" />email-derived
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Created from email {formatAge(c.emailDerivedAt)}
                  {c.emailDerivedSeedMessageId ? ` · seed ${c.emailDerivedSeedMessageId.slice(0, 12)}…` : ""}
                </p>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  size="sm"
                  variant="default"
                  disabled={claimMutation.isPending}
                  onClick={() => claimMutation.mutate(c.id)}
                  data-testid={`button-claim-${c.id}`}
                  title="Set me as the owner"
                >
                  {claimMutation.isPending && claimMutation.variables === c.id
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <UserCheck className="h-3.5 w-3.5" />}
                  <span className="ml-1">Claim</span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setAssignTarget(c); setAssignRepId(""); }}
                  data-testid={`button-assign-${c.id}`}
                  title="Assign to a rep"
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  <span className="ml-1">Assign</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setArchiveTarget(c)}
                  data-testid={`button-noise-${c.id}`}
                  title="Mark as noise and archive"
                >
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Assign dialog */}
      <Dialog open={!!assignTarget} onOpenChange={(o) => !o && setAssignTarget(null)}>
        <DialogContent data-testid="dialog-assign">
          <DialogHeader>
            <DialogTitle>Assign to a rep</DialogTitle>
            <DialogDescription>
              Set the owner for <span className="font-medium">{assignTarget?.name}</span>. The chosen rep
              will see it on their dashboard and own all future inbound email for this account.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Select value={assignRepId} onValueChange={setAssignRepId}>
              <SelectTrigger data-testid="select-assign-rep">
                <SelectValue placeholder="Pick a rep…" />
              </SelectTrigger>
              <SelectContent>
                {repOptions.map(u => (
                  <SelectItem key={u.id} value={u.id} data-testid={`select-rep-${u.id}`}>
                    {u.name || u.username}{u.role ? ` · ${u.role}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAssignTarget(null)} data-testid="button-assign-cancel">Cancel</Button>
            <Button
              disabled={!assignRepId || assignMutation.isPending}
              onClick={() => assignTarget && assignMutation.mutate({ companyId: assignTarget.id, repId: assignRepId })}
              data-testid="button-assign-confirm"
            >
              {assignMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive (mark as noise) confirmation */}
      <AlertDialog open={!!archiveTarget} onOpenChange={(o) => !o && setArchiveTarget(null)}>
        <AlertDialogContent data-testid="dialog-noise">
          <AlertDialogHeader>
            <AlertDialogTitle>Mark as noise?</AlertDialogTitle>
            <AlertDialogDescription>
              This archives <span className="font-medium">{archiveTarget?.name}</span> so it stops appearing
              in the routing queue and the customers list. You can restore it later from the admin console
              if it turns out to be a real account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-noise-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => archiveTarget && archiveMutation.mutate(archiveTarget.id)}
              data-testid="button-noise-confirm"
            >
              Mark as noise
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
