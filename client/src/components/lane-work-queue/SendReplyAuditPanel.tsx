import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Inbox,
  Mail,
  MailQuestion,
  Send,
  ShieldAlert,
  XCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface TeamMember {
  id: string;
  name: string;
  role: string;
}

interface AuditAggregates {
  drafts: number;
  attempted: number;
  sent: number;
  delivered: number;
  failed: number;
  throttled: number;
  replies: number;
  matchRate: number | null;
}

interface SendListRow {
  id: string;
  timestamp: string;
  sentAt: string | null;
  deliveryStatus: string;
  failureReason: string | null;
  carrierName: string | null;
  toEmail: string | null;
  subject: string | null;
  laneId: string | null;
  laneLabel: string;
  threadId: string | null;
  replyReceivedAt: string | null;
  outreachMode: string | null;
}

interface UnmatchedReply {
  id: string;
  receivedAt: string;
  fromEmail: string | null;
  subject: string | null;
  bodyPreview: string | null;
  conversationId: string | null;
  matchConfidence: string | null;
  bestGuessCarrier: string | null;
}

interface AuditResponse {
  rep: { id: string; name: string; email: string | null };
  window: { from: string; to: string };
  aggregates: AuditAggregates;
  perLane: Array<{ laneId: string | null; laneLabel: string; attempted: number; sent: number; failed: number; drafts: number; throttled: number; replies: number; matchRate: number | null }>;
  sendList: SendListRow[];
  unmatchedReplies: UnmatchedReply[];
  unmatchedScope: "rep" | "org";
  mailboxHealth: {
    sharedReplyMailbox: {
      hasMailReadPermission?: boolean;
      activeSubscriptions?: number;
      lastChecked?: string | null;
      reason?: string | null;
    } | null;
    repMailbox:
      | { configured: false; email: string | null }
      | {
          configured: true;
          email: string;
          enabled: boolean;
          syncStatus: string | null;
          syncError: string | null;
          subscriptionActive: boolean;
          subscriptionExpiresAt: string | null;
          lastSyncAt: string | null;
        };
  };
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function isoForInput(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const STATUS_STYLES: Record<string, { label: string; cls: string; icon: LucideIcon }> = {
  sent: { label: "Sent", cls: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30", icon: CheckCircle2 },
  failed: { label: "Failed", cls: "text-red-400 bg-red-500/10 border-red-500/30", icon: XCircle },
  draft: { label: "Draft (not sent)", cls: "text-amber-400 bg-amber-500/10 border-amber-500/30", icon: AlertCircle },
  dedup_skipped: { label: "Throttled", cls: "text-slate-400 bg-slate-500/10 border-slate-500/30", icon: ShieldAlert },
  received: { label: "Received", cls: "text-blue-400 bg-blue-500/10 border-blue-500/30", icon: Inbox },
};

interface Props {
  currentUser: { id: string; name: string; role: string } | null;
  isManager: boolean;
  teamMembers: TeamMember[];
}

export function SendReplyAuditPanel({ currentUser, isManager, teamMembers }: Props) {
  const [open, setOpen] = useState(false);
  const [repId, setRepId] = useState<string>(currentUser?.id ?? "");
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [fromDate, setFromDate] = useState<string>(isoForInput(weekAgo));
  const [toDate, setToDate] = useState<string>(isoForInput(today));
  const [showAllRows, setShowAllRows] = useState(false);
  const [includeOrgUnmatched, setIncludeOrgUnmatched] = useState(false);

  const fromIso = new Date(fromDate + "T00:00:00").toISOString();
  const toIso = new Date(toDate + "T23:59:59").toISOString();
  const effectiveRepId = repId || currentUser?.id || "";
  const orgScopeForReq = isManager && includeOrgUnmatched;

  const { data, isLoading, isError, refetch, isFetching } = useQuery<AuditResponse>({
    queryKey: ["/api/lwq/send-reply-audit", effectiveRepId, fromIso, toIso, orgScopeForReq],
    queryFn: async () => {
      const params = new URLSearchParams({ repId: effectiveRepId, from: fromIso, to: toIso });
      if (orgScopeForReq) params.set("includeOrgUnmatched", "true");
      const res = await fetch(`/api/lwq/send-reply-audit?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: open && !!effectiveRepId,
  });

  const agg = data?.aggregates;
  const visibleRows = showAllRows ? data?.sendList ?? [] : (data?.sendList ?? []).slice(0, 25);

  return (
    <div
      className="mb-5 rounded-lg border border-border bg-card overflow-hidden"
      data-testid="send-reply-audit-panel"
    >
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/30 transition-colors"
        data-testid="btn-toggle-audit-panel"
      >
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-indigo-500/15 flex items-center justify-center">
            <Activity className="w-3.5 h-3.5 text-indigo-400" />
          </div>
          <div className="text-left">
            <p className="text-xs font-semibold text-foreground">Send & Reply Audit</p>
            <p className="text-[10px] text-muted-foreground">
              Diagnose email blasts — see what sent, what failed, and where replies went.
            </p>
          </div>
        </div>
        {open ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="px-4 py-4 border-t border-border space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap items-end gap-3">
            {isManager && (
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Rep</label>
                <Select value={effectiveRepId} onValueChange={setRepId}>
                  <SelectTrigger className="h-8 text-xs w-56" data-testid="select-audit-rep">
                    <SelectValue placeholder="Select rep" />
                  </SelectTrigger>
                  <SelectContent>
                    {currentUser && (
                      <SelectItem value={currentUser.id}>{currentUser.name} (me)</SelectItem>
                    )}
                    {teamMembers
                      .filter(m => m.id !== currentUser?.id)
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map(m => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-wide text-muted-foreground">From</label>
              <Input
                type="date"
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                className="h-8 text-xs w-36"
                data-testid="input-audit-from"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-wide text-muted-foreground">To</label>
              <Input
                type="date"
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                className="h-8 text-xs w-36"
                data-testid="input-audit-to"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="btn-audit-refresh"
            >
              {isFetching ? "Refreshing…" : "Refresh"}
            </Button>
          </div>

          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : isError ? (
            <div className="text-xs text-red-400 flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              Failed to load audit. Try again.
            </div>
          ) : data ? (
            <>
              {/* Aggregates */}
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
                <Stat label="Attempted" value={agg!.attempted} cls="text-foreground" testid="stat-attempted" />
                <Stat label="Sent" value={agg!.sent} cls="text-emerald-400" testid="stat-sent" />
                <Stat label="Delivered" value={agg!.delivered} cls="text-emerald-300" testid="stat-delivered" />
                <Stat label="Failed" value={agg!.failed} cls="text-red-400" testid="stat-failed" />
                <Stat label="Drafts" value={agg!.drafts} cls="text-amber-400" testid="stat-drafts" />
                <Stat label="Throttled" value={agg!.throttled} cls="text-slate-400" testid="stat-throttled" />
                <Stat label="Replies" value={agg!.replies} cls="text-blue-400" testid="stat-replies" />
                <Stat
                  label="Match %"
                  value={agg!.matchRate == null ? "—" : `${agg!.matchRate}%`}
                  cls="text-indigo-400"
                  testid="stat-matchrate"
                />
              </div>

              {/* Diagnostic banner */}
              {agg!.attempted === 0 && (
                <div
                  className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300 flex items-start gap-2"
                  data-testid="banner-no-sends"
                >
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold">No send attempts logged for this rep in the selected window.</p>
                    <p className="text-amber-300/80 mt-0.5">
                      If the rep believed they sent a blast, the click likely never reached the server. Common causes: page closed before submit, network interruption, or the user hit "Draft" instead of "Send".
                    </p>
                  </div>
                </div>
              )}
              {agg!.attempted > 0 && agg!.sent === 0 && (
                <div
                  className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 flex items-start gap-2"
                  data-testid="banner-all-failed"
                >
                  <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold">Every send attempt failed.</p>
                    <p className="text-red-300/80 mt-0.5">See the failure reasons below — likely missing email addresses or an Outlook auth issue.</p>
                  </div>
                </div>
              )}

              {/* Per-lane breakdown */}
              <div>
                <p className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-muted-foreground" />
                  Per-Lane Breakdown ({data.perLane.length})
                </p>
                {data.perLane.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No lanes touched in this window.</p>
                ) : (
                  <div className="rounded-md border border-border overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/30">
                        <tr>
                          <th className="text-left px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">Lane</th>
                          <th className="text-right px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">Attempted</th>
                          <th className="text-right px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">Sent</th>
                          <th className="text-right px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">Failed</th>
                          <th className="text-right px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">Drafts</th>
                          <th className="text-right px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">Throttled</th>
                          <th className="text-right px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">Replies</th>
                          <th className="text-right px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">Match %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.perLane.map((row, idx) => (
                          <tr
                            key={`${row.laneId ?? "none"}-${idx}`}
                            className="border-t border-border/50 hover:bg-muted/20"
                            data-testid={`row-perlane-${row.laneId ?? "none"}`}
                          >
                            <td className="px-3 py-1.5 text-foreground truncate max-w-[260px]">{row.laneLabel}</td>
                            <td className="px-3 py-1.5 text-right text-muted-foreground">{row.attempted}</td>
                            <td className="px-3 py-1.5 text-right text-emerald-400">{row.sent}</td>
                            <td className="px-3 py-1.5 text-right text-red-400">{row.failed}</td>
                            <td className="px-3 py-1.5 text-right text-amber-400">{row.drafts}</td>
                            <td className="px-3 py-1.5 text-right text-slate-400">{row.throttled}</td>
                            <td className="px-3 py-1.5 text-right text-blue-400">{row.replies}</td>
                            <td className="px-3 py-1.5 text-right text-indigo-400">
                              {row.matchRate == null ? "—" : `${row.matchRate}%`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Mailbox health */}
              <MailboxHealth health={data.mailboxHealth} />

              {/* Send list */}
              <div>
                <p className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
                  <Send className="w-3.5 h-3.5 text-muted-foreground" />
                  Send Attempts ({data.sendList.length})
                </p>
                {data.sendList.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No send attempts in this window.</p>
                ) : (
                  <div className="rounded-md border border-border overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/30">
                        <tr>
                          <th className="text-left px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">When</th>
                          <th className="text-left px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">Status</th>
                          <th className="text-left px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">Carrier / To</th>
                          <th className="text-left px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">Lane</th>
                          <th className="text-left px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">Reply</th>
                          <th className="text-left px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleRows.map(row => {
                          const meta = STATUS_STYLES[row.deliveryStatus] ?? {
                            label: row.deliveryStatus,
                            cls: "text-muted-foreground bg-muted/30 border-border",
                            icon: AlertCircle,
                          };
                          const Icon = meta.icon;
                          return (
                            <tr
                              key={row.id}
                              className="border-t border-border/50 hover:bg-muted/20"
                              data-testid={`row-send-${row.id}`}
                            >
                              <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">
                                {fmtDate(row.timestamp)}
                              </td>
                              <td className="px-3 py-1.5">
                                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] ${meta.cls}`}>
                                  <Icon className="w-3 h-3" />
                                  {meta.label}
                                </span>
                              </td>
                              <td className="px-3 py-1.5">
                                <div className="text-foreground truncate max-w-[200px]">{row.carrierName ?? "—"}</div>
                                <div className="text-[10px] text-muted-foreground truncate max-w-[200px]">{row.toEmail ?? "(no email)"}</div>
                              </td>
                              <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[180px]">{row.laneLabel}</td>
                              <td className="px-3 py-1.5 whitespace-nowrap">
                                {row.replyReceivedAt ? (
                                  <span className="text-emerald-400">{fmtDate(row.replyReceivedAt)}</span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </td>
                              <td className="px-3 py-1.5 text-red-300/90 max-w-[240px]">
                                {row.failureReason ? (
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className="truncate inline-block max-w-[240px] cursor-help">{row.failureReason}</span>
                                      </TooltipTrigger>
                                      <TooltipContent className="max-w-sm">
                                        <p className="text-xs whitespace-pre-wrap">{row.failureReason}</p>
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                ) : (
                                  "—"
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {data.sendList.length > 25 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px] mt-1"
                    onClick={() => setShowAllRows(v => !v)}
                    data-testid="btn-toggle-all-rows"
                  >
                    {showAllRows ? "Show less" : `Show all ${data.sendList.length}`}
                  </Button>
                )}
              </div>

              {/* Unmatched replies */}
              <div>
                <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                  <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <MailQuestion className="w-3.5 h-3.5 text-muted-foreground" />
                    Unmatched / Ambiguous Replies
                    <span className="text-[10px] font-normal text-muted-foreground">
                      ({data.unmatchedScope === "org" ? "org-wide" : "scoped to rep"}, {data.unmatchedReplies.length})
                    </span>
                  </p>
                  {isManager && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px]"
                      onClick={() => setIncludeOrgUnmatched(v => !v)}
                      data-testid="btn-toggle-org-unmatched"
                    >
                      {includeOrgUnmatched ? "Show only this rep's" : "Show all org-wide"}
                    </Button>
                  )}
                </div>
                {data.unmatchedReplies.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">
                    {data.unmatchedScope === "rep"
                      ? "No unmatched replies tied to this rep's recipients in the window."
                      : "No unmatched replies — every inbound reply was tied back to a send."}
                  </p>
                ) : (
                  <div className="rounded-md border border-border divide-y divide-border/50">
                    {data.unmatchedReplies.map(r => (
                      <div key={r.id} className="px-3 py-2 text-xs" data-testid={`row-unmatched-${r.id}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <Mail className="w-3 h-3 text-muted-foreground shrink-0" />
                              <span className="font-medium text-foreground truncate">{r.fromEmail ?? "(no sender)"}</span>
                              <span className="text-[10px] text-muted-foreground shrink-0">{fmtDate(r.receivedAt)}</span>
                            </div>
                            <p className="text-foreground/90 mt-0.5 truncate">{r.subject ?? "(no subject)"}</p>
                            {r.bodyPreview && (
                              <p className="text-muted-foreground text-[11px] mt-0.5 line-clamp-2">{r.bodyPreview}</p>
                            )}
                            {r.bestGuessCarrier && (
                              <p
                                className="text-[11px] mt-1 text-indigo-300"
                                data-testid={`text-bestguess-${r.id}`}
                              >
                                Best-guess carrier: <span className="font-medium">{r.bestGuessCarrier}</span>
                              </p>
                            )}
                          </div>
                          <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-300 shrink-0">
                            {r.matchConfidence ?? "unmatched"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, cls, testid }: { label: string; value: number | string; cls: string; testid: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-2.5 py-2" data-testid={testid}>
      <p className={`text-base font-bold leading-tight ${cls}`}>{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}

function MailboxHealth({ health }: { health: AuditResponse["mailboxHealth"] }) {
  const shared = health.sharedReplyMailbox;
  const rep = health.repMailbox;

  const sharedOk = shared?.hasMailReadPermission && (shared?.activeSubscriptions ?? 0) > 0;
  const repOk = rep.configured && rep.subscriptionActive && rep.syncStatus !== "error";

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2" data-testid="mailbox-health">
      <HealthCard
        title="Shared reply mailbox"
        ok={!!sharedOk}
        lines={[
          shared?.hasMailReadPermission ? "Mail.Read granted" : (shared?.reason ?? "Mail.Read NOT granted — replies cannot be ingested"),
          `${shared?.activeSubscriptions ?? 0} active Graph subscription(s)`,
          shared?.lastChecked ? `Last checked ${fmtDate(shared.lastChecked)}` : null,
        ]}
      />
      <HealthCard
        title="Rep mailbox"
        ok={!!repOk}
        lines={
          rep.configured
            ? [
                rep.email,
                rep.subscriptionActive
                  ? (rep.subscriptionExpiresAt ? `Subscription expires ${fmtDate(rep.subscriptionExpiresAt)}` : "Subscription active")
                  : "No active subscription",
                rep.syncError ? `Last error: ${rep.syncError}` : (rep.lastSyncAt ? `Last sync ${fmtDate(rep.lastSyncAt)}` : "Never synced"),
              ]
            : [rep.email ?? "(no email on user)", "Not in monitored_mailboxes — replies to this rep won't trigger webhooks"]
        }
      />
    </div>
  );
}

function HealthCard({ title, ok, lines }: { title: string; ok: boolean; lines: Array<string | null> }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5"}`}>
      <div className="flex items-center gap-1.5">
        {ok ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
        ) : (
          <XCircle className="w-3.5 h-3.5 text-red-400" />
        )}
        <p className="text-xs font-semibold text-foreground">{title}</p>
      </div>
      <ul className="mt-1 space-y-0.5">
        {lines.filter(Boolean).map((line, i) => (
          <li key={i} className="text-[11px] text-muted-foreground">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}
