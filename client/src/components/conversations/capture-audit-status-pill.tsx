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
  Loader2,
  RefreshCw,
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
  reason: string;
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
        summary: { attempted: number; renewed: number; reregistered: number; failed: number };
        expiringPass: { expired: number; expiringSoon: number };
      }>;
    },
    onSuccess: (result) => {
      const s = result.summary;
      toast({
        title: s.failed > 0
          ? `${s.failed} mailbox${s.failed === 1 ? "" : "es"} still failing`
          : "Subscriptions renewed",
        description: `Renewed ${s.renewed}, re-registered ${s.reregistered} of ${s.attempted} mailboxes`,
        variant: s.failed > 0 ? "destructive" : "default",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations/capture-audit-health"] });
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

              {data.mailboxes.length > 0 && (
                <div className="space-y-1">
                  <div className="font-medium text-muted-foreground uppercase tracking-wide">
                    Mailbox health
                  </div>
                  <ul className="space-y-1" data-testid="list-mailbox-health">
                    {data.mailboxes.slice(0, 6).map((m) => {
                      const ok = m.sentItemsHealth === "active";
                      return (
                        <li
                          key={m.mailboxId}
                          className="flex items-start justify-between gap-2"
                          data-testid={`mailbox-health-${m.mailboxId}`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              {ok
                                ? <ShieldCheck className="w-3 h-3 text-emerald-600" />
                                : <ShieldAlert className="w-3 h-3 text-amber-600" />}
                              <span className="font-medium truncate" title={m.email}>{m.email}</span>
                              <span className="text-muted-foreground">·</span>
                              <span className={ok ? "text-emerald-600" : "text-amber-600"}>
                                {m.sentItemsHealth}
                              </span>
                            </div>
                            {!ok && (
                              <div className="text-muted-foreground pl-4">{m.reason}</div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {data.mailboxes.length > 6 && (
                    <div className="text-muted-foreground">
                      …and {data.mailboxes.length - 6} more
                    </div>
                  )}
                </div>
              )}

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
            Polls every 60s · Subs auto-renew every 6h
          </span>
          <div className="flex items-center gap-2">
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
