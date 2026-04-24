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
import { Loader2, Plus, Trash2, MailCheck, RefreshCw, AlertCircle, CheckCircle2, Clock, XCircle, Inbox, ShieldAlert, ShieldCheck, Wand2, ChevronDown, ChevronRight, X, Ban, History } from "lucide-react";

interface SentItemsHealthSnapshot {
  sentItemsHealth: "active" | "expired" | "missing" | "stale" | "unknown";
  reason: string;
  lastSentItemsNotificationAt: string | null;
  lastOutboundCapturedAt: string | null;
}

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
  // Task #435 — SentItems coverage health classifier output, computed
  // server-side. Surfaces silently-broken webhook delivery so admins
  // can act before reps complain about missing replies.
  sentItemsHealth?: SentItemsHealthSnapshot;
}

interface OrgUser {
  id: string;
  name: string;
  role: string;
  username: string;
}

// ─── SentItems coverage health badge (Task #435) ────────────────────────────
function SentItemsHealthBadge({ health, mailboxId }: { health: SentItemsHealthSnapshot; mailboxId: string }) {
  const h = health.sentItemsHealth;
  if (h === "active") {
    return (
      <Badge variant="outline" className="text-emerald-700 border-emerald-300 dark:text-emerald-300 dark:border-emerald-800" title={health.reason} data-testid={`badge-sentitems-${mailboxId}`}>
        <ShieldCheck className="h-3 w-3 mr-1" />SentItems OK
      </Badge>
    );
  }
  const variants: Record<string, string> = {
    expired: "bg-red-50 text-red-700 border-red-300 dark:bg-red-950/40 dark:text-red-300",
    missing: "bg-red-50 text-red-700 border-red-300 dark:bg-red-950/40 dark:text-red-300",
    stale: "bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300",
    unknown: "bg-muted text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={variants[h] ?? variants.unknown} title={health.reason} data-testid={`badge-sentitems-${mailboxId}`}>
      <ShieldAlert className="h-3 w-3 mr-1" />SentItems {h}
    </Badge>
  );
}

// ─── Org-wide self-heal sweep trigger (Task #435) ───────────────────────────
function SelfHealSweepButton() {
  const { toast } = useToast();
  const sweep = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/internal/admin/conversations/self-heal-sweep", { minStuckMinutes: 0 });
      return res.json() as Promise<{ scanned: number; threadsRecovered: number; healed: number; errors: number }>;
    },
    onSuccess: (r) => {
      toast({
        title: "Reply capture sweep complete",
        description: `Scanned ${r.scanned}, recovered messages on ${r.threadsRecovered} thread(s), errors: ${r.errors}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/admin/monitored-mailboxes"] });
    },
    onError: () => toast({ title: "Sweep failed", variant: "destructive" }),
  });
  return (
    <Button
      variant="outline"
      onClick={() => sweep.mutate()}
      disabled={sweep.isPending}
      data-testid="button-self-heal-sweep"
      title="Pull missing rep replies from Outlook SentItems for every stuck thread"
    >
      {sweep.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Wand2 className="h-4 w-4 mr-2" />}
      Run reply sweep
    </Button>
  );
}

// ─── Mailbox sync failures (Task #438) ──────────────────────────────────────
interface MailboxSyncFailure {
  id: string;
  mailboxId: string;
  folder: string;
  providerMessageId: string;
  errorCategory: string;
  errorMessage: string;
  attemptCount: number;
  status: "pending" | "resolved" | "dismissed" | "give_up";
  firstSeenAt: string;
  lastAttemptAt: string;
  nextAttemptAt: string | null;
}

const FAILURE_CATEGORY_LABELS: Record<string, string> = {
  graph_fetch: "Graph fetch",
  parse: "Parse",
  db_constraint: "DB constraint",
  oversize: "Oversize",
  unknown: "Unknown",
};

function MailboxFailuresSection({ mailboxId }: { mailboxId: string }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(true);
  const failuresQuery = useQuery<{ failures: MailboxSyncFailure[] }>({
    queryKey: ["/api/internal/admin/monitored-mailboxes", mailboxId, "failures"],
  });

  const retryMutation = useMutation({
    mutationFn: async (failureId: string) => {
      const res = await apiRequest("POST", `/api/internal/admin/monitored-mailboxes/${mailboxId}/failures/${failureId}/retry`);
      return res.json() as Promise<{ ok: boolean; resolved: boolean; error?: string }>;
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/admin/monitored-mailboxes", mailboxId, "failures"] });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/admin/monitored-mailboxes"] });
      toast({
        title: r.resolved ? "Message recovered" : "Retry failed",
        description: r.resolved ? "The message ingested successfully." : (r.error ?? "Will retry again later."),
        variant: r.resolved ? "default" : "destructive",
      });
    },
    onError: (err: Error) => toast({ title: "Retry error", description: err.message, variant: "destructive" }),
  });

  const dismissMutation = useMutation({
    mutationFn: async (failureId: string) => {
      const res = await apiRequest("POST", `/api/internal/admin/monitored-mailboxes/${mailboxId}/failures/${failureId}/dismiss`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/admin/monitored-mailboxes", mailboxId, "failures"] });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/admin/monitored-mailboxes"] });
      toast({ title: "Failure dismissed" });
    },
    onError: (err: Error) => toast({ title: "Dismiss error", description: err.message, variant: "destructive" }),
  });

  const failures = failuresQuery.data?.failures ?? [];
  if (failuresQuery.isLoading) {
    return (
      <div className="mt-3 pt-3 border-t flex items-center gap-2 text-sm text-muted-foreground" data-testid={`failures-loading-${mailboxId}`}>
        <Loader2 className="h-3 w-3 animate-spin" /> Loading failed messages…
      </div>
    );
  }
  if (failures.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t" data-testid={`failures-section-${mailboxId}`}>
      <button
        type="button"
        className="flex items-center gap-1 text-sm font-medium hover:underline"
        onClick={() => setOpen(o => !o)}
        data-testid={`button-toggle-failures-${mailboxId}`}
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Failed messages ({failures.length})
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {failures.map(f => {
            const isGiveUp = f.status === "give_up";
            return (
              <div
                key={f.id}
                className={`rounded-md border p-3 text-sm ${isGiveUp ? "bg-red-50 border-red-300 dark:bg-red-950/30 dark:border-red-900" : "bg-amber-50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-900"}`}
                data-testid={`failure-row-${f.id}`}
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="text-xs" data-testid={`badge-failure-category-${f.id}`}>
                      {FAILURE_CATEGORY_LABELS[f.errorCategory] ?? f.errorCategory}
                    </Badge>
                    <Badge variant="outline" className="text-xs">{f.folder}</Badge>
                    {isGiveUp && (
                      <Badge variant="destructive" className="text-xs" data-testid={`badge-failure-giveup-${f.id}`}>
                        <Ban className="h-3 w-3 mr-1" />Gave up
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground" data-testid={`text-failure-attempts-${f.id}`}>
                      {f.attemptCount} attempt{f.attemptCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={retryMutation.isPending}
                      onClick={() => retryMutation.mutate(f.id)}
                      data-testid={`button-retry-failure-${f.id}`}
                    >
                      {retryMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                      Retry now
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={dismissMutation.isPending}
                      onClick={() => dismissMutation.mutate(f.id)}
                      data-testid={`button-dismiss-failure-${f.id}`}
                    >
                      <X className="h-3 w-3 mr-1" />Dismiss
                    </Button>
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground break-all" data-testid={`text-failure-message-id-${f.id}`}>
                  Message ID: {f.providerMessageId}
                </p>
                <p className="mt-1 text-xs text-red-700 dark:text-red-300 break-words" data-testid={`text-failure-error-${f.id}`}>
                  {f.errorMessage}
                </p>
                <p className="mt-1 text-xs text-muted-foreground" data-testid={`text-failure-last-attempt-${f.id}`}>
                  Last attempt: {new Date(f.lastAttemptAt).toLocaleString()}
                  {f.nextAttemptAt && !isGiveUp && (
                    <> · Next retry: {new Date(f.nextAttemptAt).toLocaleString()}</>
                  )}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
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
  const [enrollAllOpen, setEnrollAllOpen] = useState(false);
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

  // Task #517 — preserve per-user results so the admin can audit exactly
  // who got enrolled, who was already enrolled, and who errored, instead
  // of relying solely on a toast that disappears.
  type EnrollOutcome = "enrolled" | "already_enrolled" | "skipped_no_mailbox" | "error";
  interface EnrollResultRow {
    userId: string;
    userName: string;
    email: string | null;
    outcome: EnrollOutcome;
    error?: string;
  }
  interface EnrollAllResponse {
    added: number;
    skipped: number;
    failed?: number;
    skippedNoMailbox?: number;
    eligible: number;
    totalConsidered?: number;
    results?: EnrollResultRow[];
  }
  const [enrollAllResult, setEnrollAllResult] = useState<EnrollAllResponse | null>(null);

  const enrollAllMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/internal/admin/monitored-mailboxes/enroll-all");
      return res.json() as Promise<EnrollAllResponse>;
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/admin/monitored-mailboxes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/admin/monitored-mailboxes/coverage"] });
      setEnrollAllOpen(false);
      setEnrollAllResult(r);
      const failedPart = r.failed && r.failed > 0 ? `, ${r.failed} failed` : "";
      const noMailbox = r.skippedNoMailbox && r.skippedNoMailbox > 0 ? `, ${r.skippedNoMailbox} no mailbox` : "";
      toast({
        title: r.failed && r.failed > 0 ? "Bulk enroll completed with errors" : "Bulk enroll complete",
        description: `${r.added} added, ${r.skipped} already enrolled${noMailbox}${failedPart}.`,
        variant: r.failed && r.failed > 0 ? "destructive" : "default",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Bulk enroll failed", description: err.message, variant: "destructive" });
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

  // Task #508 — per-mailbox 30-day historical backfill.
  const backfillMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/internal/admin/monitored-mailboxes/${id}/backfill`);
      return res.json() as Promise<{ status: string; messagesIngested: number; messagesDuplicate: number; messagesFetched: number; errorsCount: number; lastError?: string | null }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/admin/monitored-mailboxes/backfills"] });
      const failedNote = data.errorsCount > 0 ? `, ${data.errorsCount} error(s)` : "";
      toast({
        title: data.status === "failed" ? "Backfill failed" : "Backfill complete",
        description: `${data.messagesIngested} new, ${data.messagesDuplicate} already in system${failedNote}.`,
        variant: data.status === "failed" ? "destructive" : "default",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Backfill failed", description: err.message, variant: "destructive" });
    },
  });

  const backfillAllMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/internal/admin/monitored-mailboxes/backfill-all");
      return res.json() as Promise<{ total: number; completed: number; failed: number; skipped: number }>;
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/admin/monitored-mailboxes/backfills"] });
      toast({
        title: r.failed > 0 ? "Bulk backfill done with errors" : "Bulk backfill complete",
        description: `${r.completed} completed, ${r.skipped} skipped, ${r.failed} failed (of ${r.total}).`,
        variant: r.failed > 0 ? "destructive" : "default",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Bulk backfill failed", description: err.message, variant: "destructive" });
    },
  });

  const backfillsQuery = useQuery<{ backfills: Array<{
    id: string;
    mailboxId: string;
    status: string;
    windowStart: string;
    windowEnd: string;
    messagesFetched: number;
    messagesIngested: number;
    messagesDuplicate: number;
    errorsCount: number;
    lastError: string | null;
    completedAt: string | null;
    triggeredBy: string;
  }>}>({
    queryKey: ["/api/internal/admin/monitored-mailboxes/backfills"],
    enabled: !!user,
    refetchInterval: 15_000,
  });
  const backfillByMailbox = new Map((backfillsQuery.data?.backfills ?? []).map(b => [b.mailboxId, b]));

  const mailboxes = mailboxesQuery.data?.mailboxes ?? [];
  const orgUsers = (usersQuery.data ?? []).filter(u =>
    ["national_account_manager", "account_manager", "admin", "director", "sales_director", "logistics_manager"].includes(u.role)
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
            Manage which team member mailboxes are monitored for customer email auto-sync.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <SelfHealSweepButton />
          <Button
            variant="outline"
            onClick={() => backfillAllMutation.mutate()}
            disabled={backfillAllMutation.isPending}
            title="Pull last 30 days of mail history for every enabled mailbox"
            data-testid="button-backfill-all"
          >
            {backfillAllMutation.isPending
              ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              : <History className="h-4 w-4 mr-2" />}
            Backfill last 30 days (all)
          </Button>
          {(() => {
            const enrolledUserIds = new Set(mailboxes.map(m => m.userId));
            const enrolledEmails = new Set(mailboxes.map(m => m.email.toLowerCase()));
            const withLogin = orgUsers.filter(u => !!u.username);
            const alreadyEnrolledCount = withLogin.filter(
              u => enrolledUserIds.has(u.id) || enrolledEmails.has(u.username.toLowerCase()),
            ).length;
            const toEnroll = withLogin.length - alreadyEnrolledCount;
            const missingLoginCount = orgUsers.length - withLogin.length;
            return (
              <AlertDialog open={enrollAllOpen} onOpenChange={setEnrollAllOpen}>
                <Button
                  variant="outline"
                  onClick={() => setEnrollAllOpen(true)}
                  data-testid="button-enroll-all"
                  title="Enroll every eligible team member as a monitored mailbox"
                >
                  <MailCheck className="h-4 w-4 mr-2" />
                  Enroll all users
                </Button>
                <AlertDialogContent data-testid="dialog-enroll-all">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Enroll all eligible users?</AlertDialogTitle>
                    <AlertDialogDescription data-testid="text-enroll-all-summary">
                      This will enroll <strong>{toEnroll}</strong> eligible user{toEnroll === 1 ? "" : "s"} as
                      monitored mailboxes (using each user's login email, enabled by default).
                      {" "}<strong>{alreadyEnrolledCount}</strong> user{alreadyEnrolledCount === 1 ? "" : "s"} already
                      {alreadyEnrolledCount === 1 ? " has" : " have"} a mailbox and will be skipped.
                      {missingLoginCount > 0 && (
                        <>
                          {" "}<strong>{missingLoginCount}</strong> user{missingLoginCount === 1 ? "" : "s"} cannot be
                          enrolled because {missingLoginCount === 1 ? "they have" : "they have"} no login email on file.
                        </>
                      )}
                      {" "}You can still toggle individual mailboxes off afterwards.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel data-testid="button-enroll-all-cancel">Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={(e) => {
                        e.preventDefault();
                        enrollAllMutation.mutate();
                      }}
                      disabled={enrollAllMutation.isPending || toEnroll === 0}
                      data-testid="button-enroll-all-confirm"
                    >
                      {enrollAllMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      Enroll {toEnroll} user{toEnroll === 1 ? "" : "s"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            );
          })()}
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
                Select a team member and enter their work email address to start syncing their customer emails. Any eligible team member can be added based on their role.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="user-select">Team Member</Label>
                <Select
                  value={newUserId}
                  onValueChange={(id) => {
                    setNewUserId(id);
                    const picked = orgUsers.find(u => u.id === id);
                    if (picked?.username) setNewEmail(picked.username);
                  }}
                >
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
                <p className="text-xs text-muted-foreground">
                  Auto-filled from the team member's login email. Edit only if their Outlook address is different.
                </p>
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
      </div>

      <ReadinessChecklistCard />

      <CoverageStatusCard onResultPanelOpen={() => undefined} />

      {enrollAllResult && (
        <Card data-testid="card-enroll-all-results">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base flex items-center gap-2">
                <MailCheck className="h-4 w-4" /> Enrollment results
              </CardTitle>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEnrollAllResult(null)}
                data-testid="button-dismiss-enroll-results"
              >
                <X className="h-3 w-3 mr-1" /> Dismiss
              </Button>
            </div>
            <CardDescription data-testid="text-enroll-results-summary">
              {enrollAllResult.added} enrolled · {enrollAllResult.skipped} already enrolled
              {enrollAllResult.skippedNoMailbox ? ` · ${enrollAllResult.skippedNoMailbox} no login email` : ""}
              {enrollAllResult.failed ? ` · ${enrollAllResult.failed} failed` : ""}
            </CardDescription>
          </CardHeader>
          {enrollAllResult.results && enrollAllResult.results.length > 0 && (
            <CardContent className="pt-0">
              <div className="max-h-64 overflow-y-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">User</th>
                      <th className="text-left px-3 py-2 font-medium">Mailbox</th>
                      <th className="text-left px-3 py-2 font-medium">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {enrollAllResult.results.map(r => {
                      const tone =
                        r.outcome === "enrolled" ? "text-emerald-600 dark:text-emerald-400" :
                        r.outcome === "already_enrolled" ? "text-muted-foreground" :
                        r.outcome === "error" ? "text-red-600 dark:text-red-400" :
                        "text-amber-600 dark:text-amber-400";
                      const label =
                        r.outcome === "enrolled" ? "Enrolled" :
                        r.outcome === "already_enrolled" ? "Already enrolled" :
                        r.outcome === "skipped_no_mailbox" ? "Skipped — no login email" :
                        `Error: ${r.error ?? "unknown"}`;
                      return (
                        <tr key={r.userId} className="border-t border-border" data-testid={`row-enroll-result-${r.userId}`}>
                          <td className="px-3 py-1.5">{r.userName}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">{r.email ?? "—"}</td>
                          <td className={`px-3 py-1.5 ${tone}`}>{label}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          )}
        </Card>
      )}

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
                      {mb.sentItemsHealth && <SentItemsHealthBadge health={mb.sentItemsHealth} mailboxId={mb.id} />}
                      {/* Task #517 — Mail.Read consent is tenant-global
                          (Azure app-only), so each row mirrors the same
                          shared status. Surfacing it per-row makes the
                          gate explicit on every mailbox card. */}
                      <MailReadConsentDot mailboxId={mb.id} />
                    </div>
                    {mb.sentItemsHealth && mb.sentItemsHealth.sentItemsHealth !== "active" && (
                      <p className="text-xs text-amber-600 mt-1" data-testid={`text-sentitems-reason-${mb.id}`}>
                        SentItems: {mb.sentItemsHealth.reason}
                      </p>
                    )}
                    {mb.lastSyncAt && (
                      <p className="text-xs text-muted-foreground mt-1" data-testid={`text-mailbox-last-sync-${mb.id}`}>
                        Last synced: {new Date(mb.lastSyncAt).toLocaleString()}
                      </p>
                    )}
                    <div className="mt-1">
                      <MailboxSpotQuoteCount mailboxId={mb.id} />
                    </div>
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
                      variant="outline"
                      size="sm"
                      disabled={!mb.enabled || backfillMutation.isPending}
                      onClick={() => backfillMutation.mutate(mb.id)}
                      title="Backfill the last 30 days of mail history"
                      data-testid={`button-backfill-${mb.id}`}
                    >
                      {backfillMutation.isPending && backfillMutation.variables === mb.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <History className="h-4 w-4" />
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
                {(() => {
                  const bf = backfillByMailbox.get(mb.id);
                  if (!bf) return null;
                  const colorByStatus: Record<string, string> = {
                    pending: "text-muted-foreground",
                    running: "text-blue-600 dark:text-blue-300",
                    completed: "text-emerald-700 dark:text-emerald-300",
                    failed: "text-red-600 dark:text-red-300",
                  };
                  return (
                    <div className="mt-3 text-xs border-t pt-2" data-testid={`panel-backfill-${mb.id}`}>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-medium">30-day backfill:</span>
                        <span className={colorByStatus[bf.status] ?? ""} data-testid={`text-backfill-status-${mb.id}`}>
                          {bf.status}
                        </span>
                        <span className="text-muted-foreground">
                          window {new Date(bf.windowStart).toLocaleDateString()} → {new Date(bf.windowEnd).toLocaleDateString()}
                        </span>
                        <span data-testid={`text-backfill-counts-${mb.id}`}>
                          {bf.messagesIngested} new · {bf.messagesDuplicate} dup · {bf.messagesFetched} fetched
                          {bf.errorsCount > 0 ? ` · ${bf.errorsCount} error${bf.errorsCount === 1 ? "" : "s"}` : ""}
                        </span>
                        {bf.completedAt && (
                          <span className="text-muted-foreground">
                            finished {new Date(bf.completedAt).toLocaleString()}
                          </span>
                        )}
                        <span className="text-muted-foreground">via {bf.triggeredBy}</span>
                      </div>
                      {bf.lastError && (
                        <p className="text-red-500 mt-1" data-testid={`text-backfill-error-${mb.id}`}>{bf.lastError}</p>
                      )}
                    </div>
                  );
                })()}
                {(mb.syncStatus === "partial" || mb.syncStatus === "error") && (
                  <MailboxFailuresSection mailboxId={mb.id} />
                )}
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

// ----------------------------------------------------------------------------
// Task #549 — Go-live readiness checklist card.
//
// Renders the eight production-readiness gates (Azure creds, reply mailbox,
// APP_BASE_URL, webhook secret, Mail.Read consent, ≥1 enrolled mailbox,
// recent successful sync, no draining failures). All status / hint copy
// is computed server-side so the UI stays a pass-through renderer.
// ----------------------------------------------------------------------------
type ReadinessStatus = "ok" | "warn" | "error";
interface ReadinessCheck {
  id: string;
  label: string;
  status: ReadinessStatus;
  hint: string;
}
type ReadinessResp = {
  overall: ReadinessStatus;
  checks: ReadinessCheck[];
  summary: { ok: number; warn: number; error: number };
};

function ReadinessChecklistCard(): JSX.Element {
  const { data, isLoading, refetch, isFetching } = useQuery<ReadinessResp>({
    queryKey: ["/api/internal/admin/monitored-mailboxes/readiness"],
    refetchOnWindowFocus: false,
    refetchInterval: 60_000,
  });

  if (isLoading || !data) {
    return (
      <Card data-testid="card-readiness-loading">
        <CardContent className="py-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking go-live readiness…
        </CardContent>
      </Card>
    );
  }

  const overallTone =
    data.overall === "ok" ? "text-emerald-600 dark:text-emerald-400" :
    data.overall === "warn" ? "text-amber-600 dark:text-amber-400" :
    "text-red-600 dark:text-red-400";

  const overallLabel =
    data.overall === "ok" ? "Ready for go-live" :
    data.overall === "warn" ? "Almost ready" :
    "Not ready";

  const Icon = ({ status }: { status: ReadinessStatus }) => {
    if (status === "ok") return <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />;
    if (status === "warn") return <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />;
    return <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />;
  };

  return (
    <Card data-testid="card-readiness-checklist">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              Go-live readiness
            </CardTitle>
            <CardDescription className="mt-1" data-testid="text-readiness-overall">
              <span className={overallTone}>{overallLabel}</span> · {data.summary.ok} ok ·{" "}
              {data.summary.warn} warn · {data.summary.error} error
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-readiness"
          >
            {isFetching && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
            Re-check
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="space-y-2 text-sm">
          {data.checks.map(c => (
            <li
              key={c.id}
              className="flex items-start gap-2"
              data-testid={`row-readiness-${c.id}`}
            >
              <span className="mt-0.5"><Icon status={c.status} /></span>
              <div className="flex-1 min-w-0">
                <div className="font-medium" data-testid={`text-readiness-label-${c.id}`}>
                  {c.label}
                </div>
                <div
                  className="text-xs text-muted-foreground"
                  data-testid={`text-readiness-hint-${c.id}`}
                >
                  {c.hint}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Task #517 — Coverage status card.
//
// Renders the org's email-coverage health (eligible vs. enrolled, Mail.Read
// tenant consent, backfill state, 30-day spot-quote opportunity count) at
// the top of the admin Monitored Mailboxes page. Includes a one-click
// "re-check Mail.Read" action for after an admin grants the Azure permission.
// ----------------------------------------------------------------------------
type CoverageStatusResp = {
  severity: "ok" | "info" | "warn" | "error";
  reasons: string[];
  eligibleUsers: number;
  enrolledMailboxes: number;
  totalMailboxes: number;
  backfills: { succeeded: number; failed: number; neverRun: number; windowDays: number };
  spotQuotesFromBackfill30d: number;
  mailReadConsent: {
    status: "granted" | "pending" | "denied" | "unknown";
    lastCheckedAt: string | null;
    lastError: string | null;
    configured: boolean;
    mailbox: string | null;
  };
};

function CoverageStatusCard({ onResultPanelOpen: _ }: { onResultPanelOpen: () => void }): JSX.Element {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<CoverageStatusResp>({
    queryKey: ["/api/internal/admin/monitored-mailboxes/coverage"],
    refetchOnWindowFocus: false,
  });
  const refresh = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/internal/admin/monitored-mailboxes/refresh-mail-read");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/admin/monitored-mailboxes/coverage"] });
      toast({ title: "Mail.Read consent re-checked" });
    },
    onError: (err: Error) =>
      toast({ title: "Re-check failed", description: err.message, variant: "destructive" }),
  });

  if (isLoading || !data) return <div data-testid="loading-coverage" />;

  const c = data.mailReadConsent;
  const consentTone =
    c.status === "granted" ? "text-emerald-600 dark:text-emerald-400" :
    c.status === "denied" ? "text-red-600 dark:text-red-400" :
    "text-amber-600 dark:text-amber-400";
  const consentLabel =
    c.status === "granted" ? "granted" :
    c.status === "denied" ? "denied" :
    c.status === "pending" ? "pending" :
    "unknown";

  return (
    <Card data-testid="card-coverage-status">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Email coverage</CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            data-testid="button-recheck-mail-read"
          >
            {refresh.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
            Re-check Mail.Read
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-0 text-xs">
        <div data-testid="text-coverage-enrolled">
          <div className="text-muted-foreground">Enrolled</div>
          <div className="text-base font-semibold">{data.enrolledMailboxes} / {data.eligibleUsers}</div>
        </div>
        <div data-testid="text-coverage-mail-read">
          <div className="text-muted-foreground">Mail.Read consent</div>
          <div className={`text-base font-semibold capitalize ${consentTone}`}>{consentLabel}</div>
          {c.lastCheckedAt && (
            <div className="text-[10px] text-muted-foreground mt-0.5">
              checked {new Date(c.lastCheckedAt).toLocaleString()}
            </div>
          )}
        </div>
        <div data-testid="text-coverage-backfills">
          <div className="text-muted-foreground">Backfills (30d)</div>
          <div className="text-base font-semibold">
            {data.backfills.succeeded} OK
            {data.backfills.failed > 0 ? <span className="text-red-500"> · {data.backfills.failed} failed</span> : null}
            {data.backfills.neverRun > 0 ? <span className="text-amber-500"> · {data.backfills.neverRun} pending</span> : null}
          </div>
        </div>
        <div data-testid="text-coverage-spot-quotes">
          <div className="text-muted-foreground">Spot quotes from backfill (30d)</div>
          <div className="text-base font-semibold">{data.spotQuotesFromBackfill30d}</div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Per-mailbox spot-quote opportunity count (last 30 days). Shown inline in
 * each mailbox card so directors can see which inboxes are actually
 * generating quote opportunities from backfilled email.
 */
/**
 * Task #517 — small consent indicator on every mailbox row. Mirrors the
 * tenant-global Mail.Read state from the cached coverage query so each
 * row makes the gate visible without repeating the org-wide explanation.
 */
function MailReadConsentDot({ mailboxId }: { mailboxId: string }): JSX.Element | null {
  const { data } = useQuery<{
    mailReadConsent: { status: "granted" | "pending" | "denied" | "unknown"; configured: boolean };
  }>({
    queryKey: ["/api/internal/admin/monitored-mailboxes/coverage"],
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  if (!data?.mailReadConsent || !data.mailReadConsent.configured) return null;
  const status = data.mailReadConsent.status;
  const cfg: Record<string, { color: string; label: string }> = {
    granted: { color: "bg-green-500", label: "Mail.Read granted" },
    pending: { color: "bg-amber-500", label: "Mail.Read pending" },
    denied:  { color: "bg-red-500",   label: "Mail.Read denied — ingestion blocked" },
    unknown: { color: "bg-zinc-400",  label: "Mail.Read status unknown" },
  };
  const { color, label } = cfg[status] ?? cfg.unknown;
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${color}`}
      data-testid={`dot-mailread-${mailboxId}`}
      title={label}
      aria-label={label}
    />
  );
}

export function MailboxSpotQuoteCount({ mailboxId }: { mailboxId: string }): JSX.Element {
  const { data } = useQuery<{ spotQuotesFromBackfill30d: number; windowDays: number }>({
    queryKey: ["/api/internal/admin/monitored-mailboxes", mailboxId, "quote-stats"],
    queryFn: async () => {
      const res = await fetch(`/api/internal/admin/monitored-mailboxes/${mailboxId}/quote-stats`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  return (
    <span
      className="text-xs text-muted-foreground"
      data-testid={`text-mailbox-spotquotes-${mailboxId}`}
      title={`Spot-quote opportunities created from backfilled email in the last ${data?.windowDays ?? 30} days`}
    >
      {data ? `${data.spotQuotesFromBackfill30d} spot-quote opps (30d)` : "…"}
    </span>
  );
}
