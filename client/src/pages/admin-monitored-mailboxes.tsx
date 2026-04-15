import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, Trash2, MailCheck, RefreshCw, AlertCircle, CheckCircle2, Clock, XCircle, Inbox } from "lucide-react";

interface MonitoredMailbox {
  id: string;
  orgId: string;
  userId: string;
  email: string;
  enabled: boolean;
  subscriptionId: string | null;
  subscriptionExpiresAt: string | null;
  lastSyncAt: string | null;
  syncStatus: string;
  syncError: string | null;
  createdAt: string;
  updatedAt: string;
  userName: string;
}

interface OrgUser {
  id: string;
  name: string;
  role: string;
  username: string;
}

function SyncStatusBadge({ status, error }: { status: string; error: string | null }) {
  switch (status) {
    case "active":
      return <Badge variant="default" className="bg-green-600" data-testid="badge-sync-active"><CheckCircle2 className="h-3 w-3 mr-1" />Active</Badge>;
    case "pending":
      return <Badge variant="secondary" data-testid="badge-sync-pending"><Clock className="h-3 w-3 mr-1" />Pending</Badge>;
    case "disabled":
      return <Badge variant="outline" data-testid="badge-sync-disabled">Disabled</Badge>;
    case "error":
      return (
        <Badge variant="destructive" data-testid="badge-sync-error" title={error ?? ""}>
          <XCircle className="h-3 w-3 mr-1" />Error
        </Badge>
      );
    case "partial":
      return <Badge variant="secondary" className="bg-yellow-600 text-white" data-testid="badge-sync-partial"><AlertCircle className="h-3 w-3 mr-1" />Partial</Badge>;
    default:
      return <Badge variant="outline" data-testid="badge-sync-unknown">{status}</Badge>;
  }
}

export default function AdminMonitoredMailboxesPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MonitoredMailbox | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [newUserId, setNewUserId] = useState("");

  const mailboxesQuery = useQuery<{ mailboxes: MonitoredMailbox[] }>({
    queryKey: ["/api/internal/admin/monitored-mailboxes"],
    enabled: !!user,
  });

  const usersQuery = useQuery<OrgUser[]>({
    queryKey: ["/api/users"],
    enabled: !!user,
  });

  const addMutation = useMutation({
    mutationFn: async (data: { userId: string; email: string }) => {
      const res = await apiRequest("POST", "/api/internal/admin/monitored-mailboxes", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/admin/monitored-mailboxes"] });
      setAddDialogOpen(false);
      setNewEmail("");
      setNewUserId("");
      toast({ title: "Mailbox added", description: "The mailbox will begin syncing shortly." });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await apiRequest("PATCH", `/api/internal/admin/monitored-mailboxes/${id}`, { enabled });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/admin/monitored-mailboxes"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/internal/admin/monitored-mailboxes/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/admin/monitored-mailboxes"] });
      setDeleteTarget(null);
      toast({ title: "Mailbox removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const syncMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/internal/admin/monitored-mailboxes/${id}/sync`);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/admin/monitored-mailboxes"] });
      toast({ title: "Sync complete", description: `${data.processed ?? 0} email(s) processed.` });
    },
    onError: (err: Error) => {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    },
  });

  const mailboxes = mailboxesQuery.data?.mailboxes ?? [];
  const orgUsers = (usersQuery.data ?? []).filter(u =>
    ["national_account_manager", "account_manager", "admin", "director", "sales_director"].includes(u.role)
  );

  if (!user || !["admin", "director", "sales_director"].includes(user.role)) {
    return (
      <div className="p-8 text-center text-muted-foreground" data-testid="text-access-denied">
        You don't have access to this page.
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-4 md:space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <MailCheck className="h-6 w-6" />
            Monitored Mailboxes
          </h1>
          <p className="text-sm text-muted-foreground mt-1" data-testid="text-page-description">
            Manage which NAM/AM mailboxes are monitored for customer email auto-sync.
          </p>
        </div>

        <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-mailbox">
              <Plus className="h-4 w-4 mr-2" />
              Add Mailbox
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Monitored Mailbox</DialogTitle>
              <DialogDescription>
                Select a team member and enter their Outlook email address to start syncing their customer emails.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="user-select">Team Member</Label>
                <Select value={newUserId} onValueChange={setNewUserId}>
                  <SelectTrigger id="user-select" data-testid="select-user">
                    <SelectValue placeholder="Select a user..." />
                  </SelectTrigger>
                  <SelectContent>
                    {orgUsers.map(u => (
                      <SelectItem key={u.id} value={u.id} data-testid={`select-item-user-${u.id}`}>
                        {u.name} ({u.role.replace(/_/g, " ")})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email-input">Outlook Email</Label>
                <Input
                  id="email-input"
                  type="email"
                  placeholder="user@company.com"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  data-testid="input-mailbox-email"
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={!newUserId || !newEmail || addMutation.isPending}
                onClick={() => addMutation.mutate({ userId: newUserId, email: newEmail })}
                data-testid="button-confirm-add"
              >
                {addMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Add Mailbox
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {mailboxesQuery.isLoading ? (
        <div className="flex items-center justify-center py-12" data-testid="loading-mailboxes">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : mailboxes.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Inbox className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground" data-testid="text-no-mailboxes">
              No mailboxes are being monitored yet. Add one to start auto-syncing customer emails.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {mailboxes.map(mb => (
            <Card key={mb.id} data-testid={`card-mailbox-${mb.id}`}>
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="font-medium" data-testid={`text-mailbox-email-${mb.id}`}>{mb.email}</p>
                        <p className="text-sm text-muted-foreground" data-testid={`text-mailbox-user-${mb.id}`}>
                          {mb.userName}
                        </p>
                      </div>
                      <SyncStatusBadge status={mb.syncStatus} error={mb.syncError} />
                    </div>
                    {mb.lastSyncAt && (
                      <p className="text-xs text-muted-foreground mt-1" data-testid={`text-mailbox-last-sync-${mb.id}`}>
                        Last synced: {new Date(mb.lastSyncAt).toLocaleString()}
                      </p>
                    )}
                    {mb.syncError && (
                      <p className="text-xs text-red-500 mt-1" data-testid={`text-mailbox-error-${mb.id}`}>
                        {mb.syncError}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-3 ml-4">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`toggle-${mb.id}`} className="text-sm">
                        {mb.enabled ? "Enabled" : "Disabled"}
                      </Label>
                      <Switch
                        id={`toggle-${mb.id}`}
                        checked={mb.enabled}
                        onCheckedChange={(checked) => toggleMutation.mutate({ id: mb.id, enabled: checked })}
                        data-testid={`switch-enabled-${mb.id}`}
                      />
                    </div>

                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!mb.enabled || syncMutation.isPending}
                      onClick={() => syncMutation.mutate(mb.id)}
                      data-testid={`button-sync-${mb.id}`}
                    >
                      {syncMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                    </Button>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(mb)}
                      data-testid={`button-delete-${mb.id}`}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Monitored Mailbox</AlertDialogTitle>
            <AlertDialogDescription>
              Stop monitoring <strong>{deleteTarget?.email}</strong>? This will remove the webhook subscription and stop syncing emails from this mailbox. Previously synced emails will remain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              className="bg-red-600 hover:bg-red-700"
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
