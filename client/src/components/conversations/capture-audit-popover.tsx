import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Loader2, RefreshCcw, ShieldAlert, ShieldCheck } from "lucide-react";
import type { ConversationThread } from "./types";

interface ThreadEvidence {
  windowStart?: string;
  webhookFiredInWindow?: boolean;
  lastSentItemsNotificationAt?: string | null;
  deltaSyncRanInWindow?: boolean;
  lastSyncAt?: string | null;
  outboundCapturedInWindow?: boolean;
  lastOutboundCapturedAt?: string | null;
}

interface CaptureAuditEntry {
  id: string;
  triggeredBy: string;
  messagesFoundUpstream: number;
  messagesPersisted: number;
  rootCauseLabel: string;
  createdAt: string;
  details?: { threadEvidence?: ThreadEvidence; storedProviderMessageIds?: string[] } & Record<string, unknown>;
  storedProviderMessageIds?: string[];
}

interface MailboxHealth {
  email: string;
  enabled: boolean;
  sentItemsHealth: "active" | "expired" | "missing" | "stale" | "unknown";
  lastSentItemsNotificationAt: string | null;
  lastOutboundCapturedAt: string | null;
  reason: string;
}

interface CaptureAuditPayload {
  ok: boolean;
  mailboxHealth: MailboxHealth | null;
  storedMessageCount: number;
  storedMessages?: string[];
  history: CaptureAuditEntry[];
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
  error: "Error",
};

/**
 * Task #968 — destination summary appended to recheck-success toasts so
 * the rep knows which inbox bucket the thread lives in after the
 * pulled-in replies landed. Conservative wording — we only state what's
 * directly readable from the thread row, not anything we'd need to guess.
 */
function describeDestination(thread: ConversationThread): string {
  switch (thread.waitingState) {
    case "waiting_on_us":
      return thread.ownerUserId ? "now in Mine" : "now in Unowned";
    case "waiting_on_them":
      return "moved into Awaiting customer";
    case "resolved":
      return "moved into Resolved";
    case "archived":
      return "moved into Archived";
    case "snoozed":
      return "moved into Snoozed";
    default:
      return "moved into All";
  }
}

function HealthDot({ health }: { health: MailboxHealth["sentItemsHealth"] | undefined }) {
  if (!health || health === "active") {
    return <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />;
  }
  return <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />;
}

export function ReplyCaptureAuditButton({ thread }: { thread: ConversationThread }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  const { data, isLoading, refetch, error } = useQuery<CaptureAuditPayload>({
    queryKey: ["/api/internal/conversations", thread.threadId, "capture-audit"],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations/${encodeURIComponent(thread.threadId)}/capture-audit`);
      if (res.status === 403) throw new Error("FORBIDDEN");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: open,
    retry: false,
  });
  const forbidden = error instanceof Error && error.message === "FORBIDDEN";

  const recheck = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/internal/conversations/${encodeURIComponent(thread.threadId)}/recheck`, {});
      return res.json() as Promise<{ recovered: number; rootCause: string; messagesFoundUpstream: number }>;
    },
    onSuccess: (result) => {
      // Task #968 — wording tweak: lead with the destination summary
      // ("moved into All", "is now in Mine") so the rep knows where the
      // thread ended up after the recheck pulled missing replies in,
      // then explain the upstream cause for escalation context.
      const destinationLabel = describeDestination(thread);
      if (result.recovered > 0) {
        toast({
          title: `Pulled ${result.recovered} missing reply${result.recovered === 1 ? "" : "s"} — ${destinationLabel}`,
          description: `Root cause: ${ROOT_CAUSE_LABELS[result.rootCause] ?? result.rootCause}. The thread now matches the rep's mailbox.`,
        });
        queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations", thread.id, "messages"] });
        queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      } else {
        toast({
          title: `Thread is already up to date — ${destinationLabel}`,
          description: result.messagesFoundUpstream > 0
            ? "Every reply in the rep's SentItems is already captured here."
            : `Nothing in SentItems for this thread yet. (${ROOT_CAUSE_LABELS[result.rootCause] ?? result.rootCause})`,
        });
      }
      refetch();
    },
    onError: (err: unknown) => {
      toast({ title: "Recheck failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    },
  });

  const health = data?.mailboxHealth ?? null;
  const recoveredTotal = (data?.history ?? []).reduce((acc, h) => acc + h.messagesPersisted, 0);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="gap-1 h-8"
          data-testid="button-capture-audit"
          title="Reply capture audit — verify webhook health and pull missing replies"
        >
          <HealthDot health={health?.sentItemsHealth} />
          <span className="text-xs">Capture audit</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="end" data-testid="popover-capture-audit">
        <div className="px-4 py-3 border-b">
          <div className="text-sm font-semibold">Reply capture audit</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Verifies webhook + SentItems coverage for this thread.
          </div>
        </div>
        <div className="px-4 py-3 space-y-3 text-xs">
          {isLoading && <div className="text-muted-foreground">Loading…</div>}
          {forbidden && (
            <div className="text-amber-600" data-testid="text-audit-forbidden">
              You don't have access to this thread's capture audit. Only the
              thread owner, their direct manager, or an admin/director can
              view it.
            </div>
          )}
          {!isLoading && !forbidden && (
            <>
              <div className="space-y-1">
                <div className="font-medium text-muted-foreground uppercase tracking-wide">Mailbox health</div>
                {health ? (
                  <>
                    <div className="flex items-center gap-2">
                      <HealthDot health={health.sentItemsHealth} />
                      <span className="font-medium" data-testid="text-audit-mailbox-email">{health.email}</span>
                      <span className="text-muted-foreground">·</span>
                      <span data-testid="text-audit-health-status">{health.sentItemsHealth}</span>
                    </div>
                    <div className="text-muted-foreground" data-testid="text-audit-health-reason">{health.reason}</div>
                    {health.lastOutboundCapturedAt && (
                      <div className="text-muted-foreground">Last outbound captured: {new Date(health.lastOutboundCapturedAt).toLocaleString()}</div>
                    )}
                  </>
                ) : (
                  <div className="text-amber-600">Owner has no monitored mailbox configured.</div>
                )}
              </div>

              {(() => {
                const ev = data?.history?.[0]?.details?.threadEvidence;
                if (!ev) return null;
                const Row = ({ label, ok, ts }: { label: string; ok?: boolean; ts?: string | null }) => (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{label}</span>
                    <span className={ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600"}>
                      {ok ? "yes" : "no"}{ts ? ` · ${new Date(ts).toLocaleString()}` : ""}
                    </span>
                  </div>
                );
                return (
                  <div className="space-y-1" data-testid="section-thread-evidence">
                    <div className="font-medium text-muted-foreground uppercase tracking-wide">
                      Thread window evidence
                    </div>
                    <Row label="Webhook fired in window" ok={ev.webhookFiredInWindow} ts={ev.lastSentItemsNotificationAt} />
                    <Row label="Delta sync ran in window" ok={ev.deltaSyncRanInWindow} ts={ev.lastSyncAt} />
                    <Row label="Outbound captured in window" ok={ev.outboundCapturedInWindow} ts={ev.lastOutboundCapturedAt} />
                  </div>
                );
              })()}

              <div className="space-y-1">
                <div className="font-medium text-muted-foreground uppercase tracking-wide">Stored in this thread</div>
                <div data-testid="text-audit-stored-count">{data?.storedMessageCount ?? 0} message(s)</div>
                {(data?.storedMessages?.length ?? 0) > 0 && (
                  <details className="text-muted-foreground">
                    <summary className="cursor-pointer hover:text-foreground" data-testid="toggle-stored-ids">
                      Show Graph message IDs
                    </summary>
                    <ul className="mt-1 max-h-32 overflow-y-auto font-mono text-[10px] space-y-0.5" data-testid="list-stored-ids">
                      {data!.storedMessages!.map(id => (
                        <li key={id} className="truncate" title={id}>{id}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>

              <div className="space-y-1">
                <div className="font-medium text-muted-foreground uppercase tracking-wide">Recent self-heal runs</div>
                {(data?.history ?? []).length === 0 ? (
                  <div className="text-muted-foreground">No runs yet.</div>
                ) : (
                  <ul className="space-y-1.5" data-testid="list-audit-history">
                    {data!.history.map(h => (
                      <li key={h.id} className="flex items-start justify-between gap-2 border-l-2 pl-2 border-muted" data-testid={`audit-entry-${h.id}`}>
                        <div className="min-w-0">
                          <div className="font-medium">
                            {h.messagesPersisted > 0
                              ? `Recovered ${h.messagesPersisted} message${h.messagesPersisted === 1 ? "" : "s"}`
                              : ROOT_CAUSE_LABELS[h.rootCauseLabel] ?? h.rootCauseLabel}
                          </div>
                          <div className="text-muted-foreground">
                            {h.triggeredBy} · {new Date(h.createdAt).toLocaleString()}
                          </div>
                        </div>
                        <span className="text-muted-foreground whitespace-nowrap">
                          {h.messagesFoundUpstream} upstream
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {recoveredTotal > 0 && (
                  <div className="text-emerald-600 dark:text-emerald-400 pt-1">
                    Total recovered for this thread: {recoveredTotal}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <div className="px-4 py-2 border-t flex justify-end">
          <Button
            size="sm"
            variant="default"
            className="gap-1 h-7"
            disabled={recheck.isPending}
            onClick={() => recheck.mutate()}
            data-testid="button-recheck-capture"
          >
            {recheck.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCcw className="w-3 h-3" />}
            Re-check now
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
