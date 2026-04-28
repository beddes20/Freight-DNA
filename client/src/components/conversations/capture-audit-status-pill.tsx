/**
 * Capture Audit Status Pill (Task #536)
 *
 * Always-visible health indicator for the email capture pipeline that lives
 * at the top of the Conversations page. Three visual states:
 *   - healthy    → green "All synced" + last sync timestamp on hover
 *   - recovering → amber "N pending recovery" + click-to-open thread list
 *   - unhealthy  → red "Webhook unhealthy" + click-to-open explanation
 *
 * Backed by `GET /api/internal/conversations/capture-audit-health`. Polls
 * quietly every 60s so reps see status changes without manually refreshing.
 * Clicking the pill opens a popover summarizing recent capture-audit
 * activity, the affected threads (each clickable into the detail pane),
 * and a "Run capture audit now" trigger that calls the existing self-heal
 * logic.
 */

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  Webhook,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

type OverallStatus = "healthy" | "recovering" | "unhealthy";

interface MailboxHealth {
  mailboxId: string;
  email: string;
  enabled: boolean;
  sentItemsHealth: "active" | "expired" | "missing" | "stale" | "unknown";
  lastSentItemsNotificationAt: string | null;
  lastOutboundCapturedAt: string | null;
  /** Server-side syncStatus / syncError surfaced to the pill so the per-row
   * remediation hint can match the underlying error mode (Task #794). */
  syncStatus?: string;
  syncError?: string | null;
  reason: string;
}

interface MailboxRenewResultPayload {
  mailboxId: string;
  email: string;
  outcome: "renewed" | "reregistered" | "failed";
  syncError: string | null;
  backfill: {
    delta: { processed: number; errors: number };
    selfHeal: { scanned: number; threadsRecovered: number; errors: number };
  } | null;
}

/**
 * Map a mailbox's syncError / reason into a single short, actionable
 * remediation hint shown on the failing-mailbox row. Mirrors the most
 * common failure modes the renewal path produces in graphSubscriptionService:
 * webhook secret missing, mailbox 404, Mail.Read consent denied, and
 * generic 5xx Graph errors.
 */
function remediationHintFor(reason: string, syncError: string | null | undefined): string {
  const blob = `${syncError ?? ""} ${reason}`.toLowerCase();
  if (blob.includes("outlook_webhook_secret")) {
    return "Set OUTLOOK_WEBHOOK_SECRET in IT settings, then click Retry.";
  }
  if (blob.includes("mail.read") || blob.includes("admin consent") || blob.includes("permission denied")) {
    return "Have IT grant Mail.Read admin consent in Azure AD, then click Retry.";
  }
  if (blob.includes("not found") || blob.includes("404")) {
    return "Verify the mailbox email is exact and the user has an Outlook mailbox.";
  }
  if (blob.includes("notificationurl") || blob.includes("app_base_url")) {
    return "Set APP_BASE_URL to a public HTTPS URL Microsoft can reach.";
  }
  if (blob.includes("disabled")) {
    return "Re-enable this mailbox on the Monitored Mailboxes page first.";
  }
  if (blob.includes("expired") || blob.includes("subscription")) {
    return "Subscription needs re-registering — click Retry to refresh it now.";
  }
  if (/\b5\d{2}\b/.test(blob) || blob.includes("graph") || blob.includes("microsoft")) {
    return "Microsoft Graph returned an error — wait a minute and click Retry.";
  }
  return "Click Retry to re-register this mailbox.";
}

interface RecentRun {
  id: string;
  threadId: string;
  triggeredBy: string;
  messagesFoundUpstream: number;
  messagesPersisted: number;
  rootCauseLabel: string;
  createdAt: string;
}

interface AffectedThread {
  threadId: string;
  rootCauseLabel: string;
  messagesFoundUpstream: number;
  messagesPersisted: number;
  lastAuditAt: string;
  accountName: string | null;
  ownerName: string | null;
  recordId: string | null;
}

interface HealthPayload {
  ok: boolean;
  status: OverallStatus;
  generatedAt: string;
  lastSuccessfulSyncAt: string | null;
  pendingRecoveryThreadCount: number;
  webhookFailureCount: number;
  scope: { mailboxes: number; users: number | null };
  mailboxes: MailboxHealth[];
  recentRuns: RecentRun[];
  affectedThreads: AffectedThread[];
}

const ROOT_CAUSE_LABELS: Record<string, string> = {
  nothing_missing: "Nothing missing",
  webhook_never_fired: "Webhook never fired",
  webhook_dropped: "Webhook delivered but dropped",
  delta_stale: "Delta sync was stale",
  mailbox_disabled: "Mailbox disabled",
  mailbox_missing: "Owner has no monitored mailbox",
  subscription_expired: "Subscription expired",
  sentitems_subscription_missing: "SentItems subscription missing",
  thread_not_found: "Thread record missing",
  error: "Error during capture",
};

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  if (diffMs < 0) return new Date(iso).toLocaleString();
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function pillVisuals(status: OverallStatus, payload: HealthPayload | undefined) {
  if (!payload) {
    return {
      label: "Sync status",
      title: "Loading capture-audit status…",
      Icon: Loader2,
      className:
        "border-muted text-muted-foreground bg-muted/40",
      iconClassName: "animate-spin",
    };
  }
  switch (status) {
    case "healthy":
      return {
        label: "All synced",
        title: payload.lastSuccessfulSyncAt
          ? `Last sync ${formatRelative(payload.lastSuccessfulSyncAt)} (${new Date(payload.lastSuccessfulSyncAt).toLocaleString()})`
          : "Capture pipeline is healthy",
        Icon: CheckCircle2,
        className:
          "border-emerald-300 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 " +
          "dark:border-emerald-800 dark:text-emerald-300 dark:bg-emerald-950/40 dark:hover:bg-emerald-900/40",
        iconClassName: "",
      };
    case "recovering":
      return {
        label: payload.pendingRecoveryThreadCount > 0
          ? `${payload.pendingRecoveryThreadCount} pending recovery`
          : "Sync recovering",
        title: "Recent capture-audit issues — click to review",
        Icon: ShieldAlert,
        className:
          "border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100 " +
          "dark:border-amber-800 dark:text-amber-300 dark:bg-amber-950/40 dark:hover:bg-amber-900/40",
        iconClassName: "",
      };
    case "unhealthy":
      return {
        label: "Webhook unhealthy",
        title: "One or more mailbox subscriptions are missing or expired",
        Icon: TriangleAlert,
        className:
          "border-red-300 text-red-700 bg-red-50 hover:bg-red-100 " +
          "dark:border-red-800 dark:text-red-300 dark:bg-red-950/40 dark:hover:bg-red-900/40",
        iconClassName: "",
      };
  }
}

export function CaptureAuditStatusPill({
  onOpenThread,
}: {
  onOpenThread: (threadRecordId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth();
  const canRenew = !!user && ["admin", "director", "sales_director"].includes(user.role);

  const { data, isLoading, refetch } = useQuery<HealthPayload>({
    queryKey: ["/api/internal/conversations/capture-audit-health"],
    queryFn: async () => {
      const res = await fetch("/api/internal/conversations/capture-audit-health");
      if (!res.ok) throw new Error("Failed to load capture audit health");
      return res.json();
    },
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });

  const runNow = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/internal/conversations/capture-audit-health/run-now",
        {},
      );
      return res.json() as Promise<{ scanned: number; recovered: number; errors: number }>;
    },
    onSuccess: (result) => {
      toast({
        title: result.recovered > 0
          ? `Recovered ${result.recovered} message${result.recovered === 1 ? "" : "s"}`
          : "Capture audit complete",
        description: `Scanned ${result.scanned} thread${result.scanned === 1 ? "" : "s"}` +
          (result.errors > 0 ? ` · ${result.errors} error${result.errors === 1 ? "" : "s"}` : ""),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations/capture-audit-health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      refetch();
    },
    onError: (err: unknown) => {
      toast({
        title: "Capture audit failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  // Admin-only "Sync now" — kicks off an immediate delta-sync poll across
  // every enabled monitored mailbox. The cron polls every 5 minutes
  // automatically; this is for when the admin wants the freshest mail in
  // the platform right now without waiting for the next tick.
  const syncNow = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/internal/admin/conversations/sync-mailboxes-now",
        {},
      );
      return res.json() as Promise<{
        ok: boolean;
        started: boolean;
        reason?: string;
      }>;
    },
    onSuccess: (result) => {
      if (result.started) {
        toast({
          title: "Sync started",
          description:
            "Pulling the latest mail from every monitored inbox. New messages will appear within a minute or two.",
        });
      } else if (result.reason === "cycle_in_progress") {
        toast({
          title: "Sync already running",
          description: "A sync cycle is in progress — no need to start another.",
        });
      } else {
        toast({
          title: "Sync not started",
          description: result.reason ?? "Unknown reason",
          variant: "destructive",
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations/capture-audit-health"] });
      refetch();
    },
    onError: (err: unknown) => {
      toast({
        title: "Sync failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  // Admin-only escape hatch: re-renews every monitored mailbox's Graph
  // subscription right now. The periodic cron (every 6h) covers the normal
  // case; this button is for the rare moment when the pill goes red and
  // the admin doesn't want to wait for the next tick.
  const renewSubs = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/internal/admin/conversations/renew-mailbox-subscriptions",
        {},
      );
      return res.json() as Promise<{
        ok: boolean;
        summary: {
          attempted: number;
          renewed: number;
          reregistered: number;
          failed: number;
          results: MailboxRenewResultPayload[];
        };
        expiringPass: { expired: number; expiringSoon: number };
      }>;
    },
    onSuccess: (result) => {
      const s = result.summary;
      const failing = (s.results ?? []).filter(r => r.outcome === "failed");
      const recoveredThreads = (s.results ?? []).reduce(
        (acc, r) => acc + (r.backfill?.selfHeal.threadsRecovered ?? 0),
        0,
      );
      const backfilledMessages = (s.results ?? []).reduce(
        (acc, r) => acc + (r.backfill?.delta.processed ?? 0),
        0,
      );

      // Task #794 — name the failing mailbox(es) and the first reason so the
      // toast is actionable (used to be just a count). Cap at 2 emails to
      // keep the toast from overflowing on 40+ mailbox tenants.
      let description: string;
      if (failing.length > 0) {
        const sampleEmails = failing.slice(0, 2).map(f => f.email).join(", ");
        const overflow = failing.length > 2 ? ` +${failing.length - 2} more` : "";
        const firstReason = failing[0].syncError ?? "unknown error";
        description = `${sampleEmails}${overflow}: ${firstReason}`;
      } else {
        const parts = [`Renewed ${s.renewed}, re-registered ${s.reregistered} of ${s.attempted} mailboxes`];
        if (backfilledMessages > 0) parts.push(`pulled ${backfilledMessages} new message${backfilledMessages === 1 ? "" : "s"}`);
        if (recoveredThreads > 0) parts.push(`recovered ${recoveredThreads} thread${recoveredThreads === 1 ? "" : "s"}`);
        description = parts.join(" · ");
      }

      toast({
        title: s.failed > 0
          ? `${s.failed} mailbox${s.failed === 1 ? "" : "es"} still failing`
          : "Subscriptions renewed",
        description,
        variant: s.failed > 0 ? "destructive" : "default",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations/capture-audit-health"] });
      // Backfill ran on the server — invalidate the conversations list/threads
      // so the user sees the recovered messages without a manual refresh.
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      refetch();
    },
    onError: (err: unknown) => {
      toast({
        title: "Renewal failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  // Task #794 — Per-mailbox retry mutation backing the "Retry this mailbox"
  // button on each failing-mailbox row in the popover. Tracks the in-flight
  // mailboxId so only that row's button shows a spinner instead of the
  // whole list freezing.
  const [retryingMailboxId, setRetryingMailboxId] = useState<string | null>(null);
  const retryMailbox = useMutation({
    mutationFn: async (mailboxId: string) => {
      setRetryingMailboxId(mailboxId);
      const res = await apiRequest(
        "POST",
        `/api/internal/admin/conversations/renew-mailbox-subscriptions/${mailboxId}`,
        {},
      );
      return res.json() as Promise<{
        ok: boolean;
        mailboxId: string;
        email: string;
        result:
          | (MailboxRenewResultPayload & { skipped?: undefined })
          | { skipped: true; reason: string };
      }>;
    },
    onSuccess: (data) => {
      const r = data.result;
      if ("skipped" in r && r.skipped) {
        toast({
          title: `Couldn't retry ${data.email}`,
          description: r.reason,
          variant: "destructive",
        });
      } else if (r.outcome === "failed") {
        toast({
          title: `${data.email} still failing`,
          description: r.syncError ?? "Unknown error",
          variant: "destructive",
        });
      } else {
        const recovered = r.backfill?.selfHeal.threadsRecovered ?? 0;
        const newMessages = r.backfill?.delta.processed ?? 0;
        const parts: string[] = [r.outcome === "renewed" ? "Subscription renewed" : "Subscription re-registered"];
        if (newMessages > 0) parts.push(`pulled ${newMessages} new message${newMessages === 1 ? "" : "s"}`);
        if (recovered > 0) parts.push(`recovered ${recovered} thread${recovered === 1 ? "" : "s"}`);
        toast({
          title: `${data.email} fixed`,
          description: parts.join(" · "),
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations/capture-audit-health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      refetch();
    },
    onError: (err: unknown) => {
      toast({
        title: "Retry failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
    onSettled: () => {
      setRetryingMailboxId(null);
    },
  });

  const [showHealthyMailboxes, setShowHealthyMailboxes] = useState(false);

  const status: OverallStatus = data?.status ?? "healthy";
  const visuals = pillVisuals(status, data);
  const { Icon, iconClassName } = visuals;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={visuals.title}
          aria-label={`Capture audit status: ${visuals.label}`}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
            visuals.className,
          )}
          data-testid="pill-capture-audit-status"
          data-status={status}
        >
          <Icon className={cn("w-3.5 h-3.5", iconClassName)} />
          <span className="hidden sm:inline">{visuals.label}</span>
          <span className="sm:hidden" aria-hidden="true">
            {data?.pendingRecoveryThreadCount ?? ""}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[420px] p-0"
        align="start"
        data-testid="popover-capture-audit-status"
      >
        <div className="px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <Icon className={cn("w-4 h-4", iconClassName)} />
            <div className="text-sm font-semibold" data-testid="text-capture-audit-status-title">
              {visuals.label}
            </div>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Last sync:{" "}
            <span data-testid="text-last-sync">
              {data?.lastSuccessfulSyncAt
                ? `${formatRelative(data.lastSuccessfulSyncAt)} (${new Date(data.lastSuccessfulSyncAt).toLocaleString()})`
                : "no recent sync recorded"}
            </span>
          </div>
        </div>

        <div className="px-4 py-3 space-y-3 text-xs">
          {isLoading && (
            <div className="text-muted-foreground" data-testid="text-capture-audit-loading">
              Loading capture-audit status…
            </div>
          )}

          {!isLoading && data && (
            <>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded border p-2">
                  <div className="text-base font-semibold" data-testid="metric-mailboxes-watched">
                    {data.scope.mailboxes}
                  </div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                    Mailboxes
                  </div>
                </div>
                <div className="rounded border p-2">
                  <div
                    className={cn(
                      "text-base font-semibold",
                      data.pendingRecoveryThreadCount > 0 ? "text-amber-600 dark:text-amber-400" : "",
                    )}
                    data-testid="metric-pending-recovery"
                  >
                    {data.pendingRecoveryThreadCount}
                  </div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                    Pending
                  </div>
                </div>
                <div className="rounded border p-2">
                  <div
                    className={cn(
                      "text-base font-semibold",
                      data.webhookFailureCount > 0 ? "text-red-600 dark:text-red-400" : "",
                    )}
                    data-testid="metric-webhook-failures"
                  >
                    {data.webhookFailureCount}
                  </div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                    Webhook issues
                  </div>
                </div>
              </div>

              {data.mailboxes.length > 0 && (() => {
                // Task #794: pin failing mailboxes (anything not "active") to
                // the top, never hide them behind a "…and N more" cutoff. The
                // healthy mailboxes are collapsed by default into a single
                // expander so a 40-mailbox tenant doesn't drown the popover.
                const failingMailboxes = data.mailboxes.filter(m => m.sentItemsHealth !== "active");
                const healthyMailboxes = data.mailboxes.filter(m => m.sentItemsHealth === "active");
                const renderMailbox = (m: MailboxHealth) => {
                  const ok = m.sentItemsHealth === "active";
                  const reasonText = m.syncError && m.syncError !== m.reason
                    ? `${m.reason} — ${m.syncError}`
                    : m.reason;
                  const isRetryingThis = retryingMailboxId === m.mailboxId && retryMailbox.isPending;
                  return (
                    <li
                      key={m.mailboxId}
                      className="flex items-start justify-between gap-2"
                      data-testid={`mailbox-health-${m.mailboxId}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          {ok
                            ? <ShieldCheck className="w-3 h-3 text-emerald-600 flex-shrink-0" />
                            : <ShieldAlert className="w-3 h-3 text-amber-600 flex-shrink-0" />}
                          <span className="font-medium truncate" title={m.email} data-testid={`text-mailbox-email-${m.mailboxId}`}>{m.email}</span>
                          <span className="text-muted-foreground">·</span>
                          <span className={ok ? "text-emerald-600" : "text-amber-600"} data-testid={`text-mailbox-health-${m.mailboxId}`}>
                            {m.sentItemsHealth}
                          </span>
                        </div>
                        {!ok && (
                          <>
                            <div
                              className="text-muted-foreground pl-4 break-words"
                              data-testid={`text-mailbox-reason-${m.mailboxId}`}
                            >
                              {reasonText}
                            </div>
                            <div
                              className="pl-4 mt-0.5 text-[11px] text-amber-700 dark:text-amber-400"
                              data-testid={`text-mailbox-remediation-${m.mailboxId}`}
                            >
                              → {remediationHintFor(m.reason, m.syncError)}
                            </div>
                          </>
                        )}
                      </div>
                      {!ok && canRenew && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px] gap-1 flex-shrink-0"
                          disabled={isRetryingThis || retryMailbox.isPending}
                          onClick={() => retryMailbox.mutate(m.mailboxId)}
                          data-testid={`button-retry-mailbox-${m.mailboxId}`}
                          title={`Re-register ${m.email} and pull any missed mail right now`}
                        >
                          {isRetryingThis
                            ? <Loader2 className="w-3 h-3 animate-spin" />
                            : <RotateCw className="w-3 h-3" />}
                          Retry
                        </Button>
                      )}
                    </li>
                  );
                };

                return (
                  <div className="space-y-1">
                    <div className="font-medium text-muted-foreground uppercase tracking-wide">
                      Mailbox health
                    </div>
                    <ul className="space-y-1.5" data-testid="list-mailbox-health">
                      {failingMailboxes.map(renderMailbox)}
                      {failingMailboxes.length === 0 && healthyMailboxes.length > 0 && (
                        <li className="text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5" data-testid="text-all-mailboxes-healthy">
                          <ShieldCheck className="w-3 h-3" />
                          All {healthyMailboxes.length} mailbox{healthyMailboxes.length === 1 ? "" : "es"} healthy
                        </li>
                      )}
                    </ul>
                    {failingMailboxes.length > 0 && healthyMailboxes.length > 0 && (
                      <>
                        <button
                          type="button"
                          onClick={() => setShowHealthyMailboxes(v => !v)}
                          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                          data-testid="button-toggle-healthy-mailboxes"
                        >
                          {showHealthyMailboxes
                            ? <ChevronDown className="w-3 h-3" />
                            : <ChevronRight className="w-3 h-3" />}
                          {showHealthyMailboxes ? "Hide" : "Show"} {healthyMailboxes.length} healthy
                        </button>
                        {showHealthyMailboxes && (
                          <ul className="space-y-1.5 mt-1" data-testid="list-healthy-mailboxes">
                            {healthyMailboxes.map(renderMailbox)}
                          </ul>
                        )}
                      </>
                    )}
                  </div>
                );
              })()}

              {data.affectedThreads.length > 0 && (
                <div className="space-y-1">
                  <div className="font-medium text-muted-foreground uppercase tracking-wide">
                    Threads pending recovery
                  </div>
                  <ul className="space-y-1.5 max-h-48 overflow-y-auto" data-testid="list-affected-threads">
                    {data.affectedThreads.map((t) => (
                      <li
                        key={t.threadId}
                        className="border-l-2 border-amber-300 pl-2"
                        data-testid={`affected-thread-${t.threadId}`}
                      >
                        {t.recordId ? (
                          <button
                            type="button"
                            className="text-left hover:underline"
                            onClick={() => {
                              if (t.recordId) {
                                onOpenThread(t.threadId);
                                setOpen(false);
                              }
                            }}
                            data-testid={`button-open-affected-${t.threadId}`}
                          >
                            <div className="font-medium">
                              {t.accountName ?? "Unlinked thread"}
                              {t.ownerName ? <span className="text-muted-foreground"> · {t.ownerName}</span> : null}
                            </div>
                            <div className="text-muted-foreground">
                              {ROOT_CAUSE_LABELS[t.rootCauseLabel] ?? t.rootCauseLabel}
                              {" · "}
                              {formatRelative(t.lastAuditAt)}
                            </div>
                          </button>
                        ) : (
                          <div>
                            <div className="font-medium">
                              {t.accountName ?? "Unlinked thread"}
                            </div>
                            <div className="text-muted-foreground">
                              {ROOT_CAUSE_LABELS[t.rootCauseLabel] ?? t.rootCauseLabel}
                              {" · "}
                              {formatRelative(t.lastAuditAt)}
                            </div>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="space-y-1">
                <div className="font-medium text-muted-foreground uppercase tracking-wide">
                  Recent capture audits
                </div>
                {data.recentRuns.length === 0 ? (
                  <div className="text-muted-foreground" data-testid="text-no-recent-runs">
                    No capture-audit runs in the last 24h.
                  </div>
                ) : (
                  <ul className="space-y-1" data-testid="list-recent-runs">
                    {data.recentRuns.slice(0, 5).map((r) => (
                      <li
                        key={r.id}
                        className="flex items-start justify-between gap-2"
                        data-testid={`recent-run-${r.id}`}
                      >
                        <div className="min-w-0">
                          <div className="font-medium">
                            {r.messagesPersisted > 0
                              ? `Recovered ${r.messagesPersisted} message${r.messagesPersisted === 1 ? "" : "s"}`
                              : ROOT_CAUSE_LABELS[r.rootCauseLabel] ?? r.rootCauseLabel}
                          </div>
                          <div className="text-muted-foreground">
                            {r.triggeredBy} · {formatRelative(r.createdAt)}
                          </div>
                        </div>
                        <span className="text-muted-foreground whitespace-nowrap">
                          {r.messagesFoundUpstream} upstream
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>

        <div className="px-4 py-2 border-t flex items-center justify-between gap-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground">
            Mail polled every 5 min · Webhooks push in real time · Subs auto-renew every 6h
          </span>
          <div className="flex items-center gap-2">
            {canRenew && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1 h-7"
                disabled={syncNow.isPending}
                onClick={() => syncNow.mutate()}
                data-testid="button-sync-mailboxes-now"
                title="Pull the latest mail from every monitored inbox right now (cron does this automatically every 5 minutes)"
              >
                {syncNow.isPending
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <Download className="w-3 h-3" />}
                Sync mail now
              </Button>
            )}
            {canRenew && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1 h-7"
                disabled={renewSubs.isPending}
                onClick={() => renewSubs.mutate()}
                data-testid="button-renew-mailbox-subscriptions"
                title="Re-register every monitored mailbox's webhook subscription with Microsoft Graph right now"
              >
                {renewSubs.isPending
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <Webhook className="w-3 h-3" />}
                Renew subscriptions now
              </Button>
            )}
            <Button
              size="sm"
              variant="default"
              className="gap-1 h-7"
              disabled={runNow.isPending}
              onClick={() => runNow.mutate()}
              data-testid="button-run-capture-audit-now"
              title="Force a capture-audit pass across the threads visible to you"
            >
              {runNow.isPending
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <RefreshCw className="w-3 h-3" />}
              Run capture audit now
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
