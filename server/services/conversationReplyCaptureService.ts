/**
 * Conversation Reply Capture Self-Heal Service (Task #435)
 *
 * Reps keep reporting that their email replies (sent from Outlook) never
 * appear in the Conversations thread, leaving the thread stuck in
 * "Waiting on us". The capture pipeline has multiple independent failure
 * points (webhook drop, expired SentItems subscription, stale delta token,
 * mailbox not enabled, account-match drop, dedup false-positive). This
 * service makes the pipeline self-healing:
 *
 *   selfHealConversationThread(orgId, threadId) — given a thread, query
 *     Microsoft Graph SentItems on the owner's monitored mailbox for any
 *     messages in this Outlook conversationId since the thread's last
 *     outbound, and ingest anything missing through the existing
 *     processUserMailboxEmail path. Idempotent (relies on
 *     providerMessageId dedup).
 *
 *   selfHealStuckThreads(orgId?) — periodic sweep of waiting_on_us
 *     threads whose owner has a monitored mailbox enabled, runs the
 *     per-thread routine. Rate-limited per mailbox.
 *
 *   getMailboxSentItemsHealth(mailbox) — pure helper that classifies a
 *     monitored mailbox's SentItems coverage as
 *     active | expired | missing | stale, used by both the thread side
 *     panel and the admin monitored-mailboxes UI.
 *
 * Every per-thread run records a row in `conversation_thread_capture_audits`
 * so reps can see, for any thread, which capture path failed and what the
 * platform did to repair it.
 */

import cron from "node-cron";
import { storage, db } from "../storage";
import { JOB_NAMES, withHeartbeat, EMAIL_PIPELINE_JOBS, CRITICAL_EMAIL_PIPELINE_JOBS } from "../lib/cronHeartbeat";
import {
  conversationThreadCaptureAudits,
  emailMessages,
  emailConversationThreads,
  monitoredMailboxes,
  type MonitoredMailbox,
  type ConversationThreadCaptureAudit,
  type EmailConversationThread,
  type MonitorMode,
} from "@shared/schema";
import { and, eq, desc, gte, isNotNull, sql as drizzleSql } from "drizzle-orm";
import { azureCredentialsConfigured, getGraphAccessToken } from "../graphService";
import { getReplyTrackingStatus } from "../graphSubscriptionService";
import { recordIntegrationEvent } from "../integrations/probeRegistry";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [reply-capture] ${msg}`);
}

// ─── SentItems health classifier ─────────────────────────────────────────────

export type SentItemsHealth = "active" | "expired" | "missing" | "stale" | "unknown";

export interface MailboxHealthSnapshot {
  mailboxId: string;
  email: string;
  enabled: boolean;
  /** Task #997: canonical monitor-mode that governs whether this mailbox
   *  participates in the rollup, the alerter, and the retry buttons. The
   *  popover renders Action Required / Config Issues / Excluded sections
   *  off this field; non-`monitored_active` rows never inflate
   *  `webhookFailureCount` and never push the pill red on their own. */
  monitorMode: MonitorMode;
  sentItemsHealth: SentItemsHealth;
  inboxSubscriptionId: string | null;
  sentItemsSubscriptionId: string | null;
  subscriptionExpiresAt: string | null;
  lastSentItemsNotificationAt: string | null;
  lastOutboundCapturedAt: string | null;
  lastSyncAt: string | null;
  syncStatus: string;
  syncError: string | null;
  reason: string;
}

/**
 * 4-hour staleness threshold for "no SentItems traffic seen".
 *
 * History: was 24h, but combined with `lastSyncAt` in the staleness verdict
 * the signal almost never fired in practice — a delta-sync poll every 5 min
 * kept `lastSyncAt` fresh enough to mask a silently-dropped subscription for
 * up to a full day. We now (a) lower the window to 4h to match an AM/NAM
 * half-workday cadence and (b) compute the staleness verdict from
 * SentItems-specific timestamps only (excluding `lastSyncAt`) so a dropped
 * subscription is detectable even when delta-sync polling is healthy.
 *
 * `lastSyncAt` is still consulted by `getCaptureAuditHealthForUsers` for the
 * `lastSuccessfulSyncAt` field (Task #794: pill flips green right after a
 * manual renewal/backfill), so this change does not regress that behavior.
 */
const SENTITEMS_STALE_MS = 4 * 60 * 60 * 1000;

export function getMailboxSentItemsHealth(mb: MonitoredMailbox): MailboxHealthSnapshot {
  const now = Date.now();
  let health: SentItemsHealth = "active";
  let reason = "SentItems subscription active";

  // Task #997: non-active monitor modes never roll the pill red, never feed
  // `webhookFailureCount`, and never trigger the alerter. We classify them
  // as `unknown` (rather than `missing`/`expired`) and surface the reason
  // verbatim so the popover can group them under Config Issues / Excluded.
  // Returning early also prevents the "subscription expired" branch below
  // from generating misleading copy for rows whose sub IDs were cleared by
  // the migration.
  const monitorMode = (mb.monitorMode as MonitorMode | null) ?? "monitored_active";
  if (monitorMode !== "monitored_active") {
    const modeReason: Record<Exclude<MonitorMode, "monitored_active">, string> = {
      excluded_intentional: "Excluded intentionally — not monitored",
      invalid_config: "Invalid mailbox config — admin must fix the row before re-monitoring",
      disabled: "Mailbox disabled by admin — not subscribed",
    };
    return {
      mailboxId: mb.id,
      email: mb.email,
      enabled: mb.enabled,
      monitorMode,
      sentItemsHealth: "unknown",
      inboxSubscriptionId: mb.subscriptionId,
      sentItemsSubscriptionId: mb.sentItemsSubscriptionId,
      subscriptionExpiresAt: mb.subscriptionExpiresAt?.toISOString() ?? null,
      lastSentItemsNotificationAt: mb.lastSentItemsNotificationAt?.toISOString() ?? null,
      lastOutboundCapturedAt: mb.lastOutboundCapturedAt?.toISOString() ?? null,
      lastSyncAt: mb.lastSyncAt?.toISOString() ?? null,
      syncStatus: mb.syncStatus,
      syncError: mb.syncError,
      reason: modeReason[monitorMode as Exclude<MonitorMode, "monitored_active">],
    };
  }

  if (!mb.enabled) {
    health = "missing";
    reason = "Mailbox disabled — not subscribed to SentItems";
  } else if (!mb.sentItemsSubscriptionId) {
    health = "missing";
    reason = "No SentItems subscription registered";
  } else if (mb.subscriptionExpiresAt && mb.subscriptionExpiresAt.getTime() < now) {
    health = "expired";
    reason = `Subscription expired ${mb.subscriptionExpiresAt.toISOString()}`;
  } else {
    // We have a sub — but has the SentItems channel itself delivered anything
    // in the staleness window? Compute the verdict from SentItems-specific
    // timestamps ONLY (excluding `lastSyncAt`) so a silently-dropped sub is
    // detectable even when the unrelated delta-sync poll is healthy.
    const lastSentItemsTraffic = Math.max(
      mb.lastSentItemsNotificationAt?.getTime() ?? 0,
      mb.lastOutboundCapturedAt?.getTime() ?? 0,
    );
    if (lastSentItemsTraffic > 0 && now - lastSentItemsTraffic > SENTITEMS_STALE_MS) {
      health = "stale";
      const ageHrs = Math.round((now - lastSentItemsTraffic) / (60 * 60 * 1000));
      reason = `No SentItems traffic in ${ageHrs}h — webhook may be silently dropped`;
    } else if (lastSentItemsTraffic === 0 && mb.createdAt && now - mb.createdAt.getTime() > SENTITEMS_STALE_MS) {
      health = "stale";
      reason = "Subscription registered but never delivered an outbound notification";
    }
  }

  return {
    mailboxId: mb.id,
    email: mb.email,
    enabled: mb.enabled,
    monitorMode,
    sentItemsHealth: health,
    inboxSubscriptionId: mb.subscriptionId,
    sentItemsSubscriptionId: mb.sentItemsSubscriptionId,
    subscriptionExpiresAt: mb.subscriptionExpiresAt?.toISOString() ?? null,
    lastSentItemsNotificationAt: mb.lastSentItemsNotificationAt?.toISOString() ?? null,
    lastOutboundCapturedAt: mb.lastOutboundCapturedAt?.toISOString() ?? null,
    lastSyncAt: mb.lastSyncAt?.toISOString() ?? null,
    syncStatus: mb.syncStatus,
    syncError: mb.syncError,
    reason,
  };
}

// ─── Graph SentItems lookup by conversationId ────────────────────────────────

interface GraphSentItem {
  id: string;
  conversationId?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  ccRecipients?: Array<{ emailAddress?: { address?: string } }>;
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string; contentType?: string };
  sentDateTime?: string;
  internetMessageId?: string;
}

async function fetchSentItemsByConversation(
  mailboxEmail: string,
  conversationId: string,
  sinceDate: Date | null,
): Promise<GraphSentItem[]> {
  const token = await getGraphAccessToken();
  const select = "id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,sentDateTime,internetMessageId";
  // Bias to a recent window even when sinceDate is null so we don't scan
  // an entire SentItems folder for never-synced threads.
  const since = sinceDate ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Microsoft Graph rejects `conversationId eq '...' and sentDateTime ge ...`
  // combined with `$orderby=sentDateTime` on Outlook mailboxes — Graph returns
  // 400 InefficientFilter ("The restriction or sort order is too complex").
  // The proven-safe shape on every Outlook tenant is a single-field equality
  // on conversationId with no $orderby, paged via @odata.nextLink. We then
  // apply the `since` guardrail and chronological ordering client-side.
  const filter = `conversationId eq '${conversationId.replace(/'/g, "''")}'`;
  let url: string | undefined =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailboxEmail)}/mailFolders/sentitems/messages?$select=${select}&$filter=${encodeURIComponent(filter)}&$top=50`;

  // Follow @odata.nextLink so long threads / busy windows are recovered
  // completely. Hard cap at 10 pages (≤500 items per thread) as a safety
  // guard against runaway pagination.
  const all: GraphSentItem[] = [];
  for (let page = 0; page < 10 && url; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Graph SentItems lookup failed (${res.status}): ${err.slice(0, 200)}`);
    }
    const data = await res.json() as { value?: GraphSentItem[]; "@odata.nextLink"?: string };
    if (data.value?.length) all.push(...data.value);
    url = data["@odata.nextLink"];
  }

  // Apply the `since` guardrail and chronological ordering client-side, since
  // Graph wouldn't let us push them into the query.
  const sinceMs = since.getTime();
  return all
    .filter(m => {
      if (!m.sentDateTime) return true;
      const t = new Date(m.sentDateTime).getTime();
      return Number.isFinite(t) ? t >= sinceMs : true;
    })
    .sort((a, b) => {
      const at = a.sentDateTime ? new Date(a.sentDateTime).getTime() : 0;
      const bt = b.sentDateTime ? new Date(b.sentDateTime).getTime() : 0;
      return at - bt;
    });
}

// ─── Per-thread self-heal ────────────────────────────────────────────────────

export interface SelfHealResult {
  audit: ConversationThreadCaptureAudit;
  thread: EmailConversationThread | null;
  mailboxHealth: MailboxHealthSnapshot | null;
  storedProviderMessageIds: string[];
}

export async function selfHealConversationThread(opts: {
  orgId: string;
  threadId: string;
  triggeredBy: "scheduled" | "manual" | "webhook_repair";
  triggeredByUserId?: string | null;
}): Promise<SelfHealResult> {
  const { orgId, threadId, triggeredBy, triggeredByUserId } = opts;

  const persistedIds: string[] = [];
  let mailboxId: string | null = null;
  let rootCauseLabel: string = "nothing_missing";
  const details: Record<string, unknown> = { triggeredBy };
  let messagesFoundUpstream = 0;
  let messagesPersisted = 0;
  let mailboxHealth: MailboxHealthSnapshot | null = null;

  const thread = await storage.getEmailConversationThreadByThreadId(orgId, threadId);
  if (!thread) {
    rootCauseLabel = "thread_not_found";
    details.error = "No email_conversation_threads row exists yet for this threadId";
  } else {
    let mailbox: MonitoredMailbox | undefined;
    if (thread.ownerUserId) {
      // Owner's monitored mailbox lookup (any in-org mailbox owned by this user)
      const ownerMailboxes = await db.select().from(monitoredMailboxes)
        .where(and(
          eq(monitoredMailboxes.orgId, orgId),
          eq(monitoredMailboxes.userId, thread.ownerUserId),
        ));
      mailbox = ownerMailboxes[0];
    }

    // Capture per-thread evidence about which capture paths could have run
    // since the thread last received an inbound. This satisfies the
    // requirement to show explicit "webhook fired?" / "delta picked
    // anything up?" signals for the thread's window.
    if (mailbox) {
      const windowStart = thread.lastIncomingAt ?? thread.createdAt ?? new Date(0);
      details.threadEvidence = {
        windowStart: windowStart.toISOString(),
        webhookFiredInWindow: !!(mailbox.lastSentItemsNotificationAt && mailbox.lastSentItemsNotificationAt > windowStart),
        lastSentItemsNotificationAt: mailbox.lastSentItemsNotificationAt?.toISOString() ?? null,
        deltaSyncRanInWindow: !!(mailbox.lastSyncAt && mailbox.lastSyncAt > windowStart),
        lastSyncAt: mailbox.lastSyncAt?.toISOString() ?? null,
        outboundCapturedInWindow: !!(mailbox.lastOutboundCapturedAt && mailbox.lastOutboundCapturedAt > windowStart),
        lastOutboundCapturedAt: mailbox.lastOutboundCapturedAt?.toISOString() ?? null,
      };
    }

    if (!mailbox) {
      rootCauseLabel = "mailbox_missing";
      details.error = "Thread owner has no monitored mailbox configured";
    } else {
      mailboxId = mailbox.id;
      mailboxHealth = getMailboxSentItemsHealth(mailbox);
      details.mailboxHealth = mailboxHealth;

      if (!mailbox.enabled) {
        rootCauseLabel = "mailbox_disabled";
        details.error = "Owner's monitored mailbox is disabled — cannot query Graph";
      } else if (!azureCredentialsConfigured()) {
        rootCauseLabel = "error";
        details.error = "Azure credentials not configured";
      } else {
        try {
          const upstream = await fetchSentItemsByConversation(
            mailbox.email,
            threadId,
            thread.lastOutgoingAt ?? null,
          );
          messagesFoundUpstream = upstream.length;
          details.upstreamMessageIds = upstream.map(m => m.id);

          if (upstream.length === 0) {
            // Nothing in SentItems for this conversation since lastOutgoing.
            // Either the rep genuinely hasn't sent anything, or the gap is
            // older than our 7d guardrail window — leave nothing_missing.
            rootCauseLabel = "nothing_missing";
          } else {
            const { processUserMailboxEmailForDelta } = await import("../routes/graphWebhook");
            for (const msg of upstream) {
              try {
                // Pre-check: is this providerMessageId already stored?
                const before = await db.select({ id: emailMessages.id })
                  .from(emailMessages)
                  .where(and(
                    eq(emailMessages.orgId, orgId),
                    eq(emailMessages.providerMessageId, msg.id),
                  ))
                  .limit(1);
                const wasMissing = before.length === 0;

                const fromEmail = msg.from?.emailAddress?.address ?? "";
                const fromName = msg.from?.emailAddress?.name ?? "";
                const allTo = (msg.toRecipients ?? []).map(r => r.emailAddress?.address).filter((a): a is string => !!a);
                const allCc = (msg.ccRecipients ?? []).map(r => r.emailAddress?.address).filter((a): a is string => !!a);
                const toEmail = allTo[0] ?? "";
                const subject = msg.subject ?? "";
                const bodyPreview = msg.bodyPreview?.slice(0, 255) ?? "";
                const bodyFull = msg.body?.content ?? bodyPreview;
                const sentAt = msg.sentDateTime ? new Date(msg.sentDateTime) : new Date();

                const ingestResult = await processUserMailboxEmailForDelta({
                  orgId,
                  monitoredMailbox: { id: mailbox.id, userId: mailbox.userId, email: mailbox.email },
                  fromEmail,
                  fromName,
                  toEmail,
                  allToRecipients: [...allTo, ...allCc],
                  subject,
                  bodyPreview,
                  bodyFull: bodyFull.slice(0, 8000),
                  conversationId: threadId,
                  providerMessageId: msg.id,
                  receivedAt: sentAt,
                  mailboxEmail: mailbox.email,
                });

                // Task #874 — self-heal sweep is one of the three real-time
                // ingest paths advertised in `server/services/liveSync.ts`.
                // Mirror the webhook + delta-sync emit so a recovered sent
                // message shows up in the Conversations page within seconds.
                // Gated on `created` so a sweep that re-finds an already
                // ingested row does not re-emit. Best-effort.
                if (ingestResult.created) {
                  try {
                    const { publish: publishLiveSync } = await import("./liveSync");
                    publishLiveSync(
                      orgId,
                      ingestResult.direction === "outbound" ? "mailbox_outbound" : "mailbox_inbound",
                      threadId ?? undefined,
                    );
                  } catch (pubErr) {
                    log(`[self-heal] live-sync publish failed for msgId=${msg.id}: ${pubErr instanceof Error ? pubErr.message : String(pubErr)}`);
                  }
                }

                if (wasMissing) {
                  // Confirm it actually persisted (account-match drop guard).
                  const after = await db.select({ id: emailMessages.id })
                    .from(emailMessages)
                    .where(and(
                      eq(emailMessages.orgId, orgId),
                      eq(emailMessages.providerMessageId, msg.id),
                    ))
                    .limit(1);
                  if (after.length > 0) {
                    persistedIds.push(msg.id);
                    messagesPersisted++;
                  }
                }
              } catch (msgErr) {
                const errMsg = msgErr instanceof Error ? msgErr.message : String(msgErr);
                log(`[self-heal] message ingest error msgId=${msg.id}: ${errMsg}`);
                // Surface this previously-silent failure on the Integrations
                // Health console so admins can see "self-heal is finding
                // messages but failing to persist them" instead of only
                // discovering it via per-thread audit drilldown.
                recordIntegrationEvent({
                  source: "graph",
                  outcome: "error",
                  errorMessage: `self_heal_message_ingest:${msg.id}: ${errMsg.slice(0, 200)}`,
                });
              }
            }

            if (messagesPersisted > 0) {
              // Classify why the original capture path missed it.
              const lastNotif = mailbox.lastSentItemsNotificationAt;
              const subExpired = mailbox.subscriptionExpiresAt && mailbox.subscriptionExpiresAt.getTime() < Date.now();
              if (!mailbox.sentItemsSubscriptionId) {
                rootCauseLabel = "sentitems_subscription_missing";
              } else if (subExpired) {
                rootCauseLabel = "subscription_expired";
              } else if (!lastNotif || (Date.now() - lastNotif.getTime()) > SENTITEMS_STALE_MS) {
                rootCauseLabel = "webhook_never_fired";
              } else {
                rootCauseLabel = "webhook_dropped";
              }
            } else {
              rootCauseLabel = "nothing_missing";
            }
          }
        } catch (graphErr) {
          rootCauseLabel = "error";
          details.error = graphErr instanceof Error ? graphErr.message : String(graphErr);
          log(`[self-heal] graph error org=${orgId} thread=${threadId}: ${details.error}`);
        }
      }
    }
  }

  details.persistedProviderMessageIds = persistedIds;

  const [audit] = await db.insert(conversationThreadCaptureAudits).values({
    orgId,
    threadId,
    mailboxId,
    triggeredBy,
    triggeredByUserId: triggeredByUserId ?? null,
    messagesFoundUpstream,
    messagesPersisted,
    rootCauseLabel,
    details,
  }).returning();

  if (messagesPersisted > 0) {
    log(`Recovered ${messagesPersisted} message(s) for thread=${threadId} cause=${rootCauseLabel}`);
    // Audit: surface capture-recoveries on the per-thread timeline (Task #534)
    // so reps can see when the platform pulled in messages that were
    // previously missing from their inbox view. Best-effort import — keep
    // it inside the if-block so threads that didn't actually recover
    // don't get noisy entries on every audit pass.
    try {
      const { recordThreadEvent } = await import("./conversationThreadEventsService");
      await recordThreadEvent({
        orgId,
        threadId,
        eventType: "capture_audit_recovery",
        description: `Recovered ${messagesPersisted} missing message${messagesPersisted === 1 ? "" : "s"} (${rootCauseLabel})`,
        actorUserId: triggeredByUserId ?? null,
        actorName: null,
        details: { triggeredBy, messagesFoundUpstream, messagesPersisted, rootCauseLabel },
      });
    } catch (auditErr) {
      console.error("[capture-audit] failed to log thread event:", auditErr);
    }
  }

  const finalThread = await storage.getEmailConversationThreadByThreadId(orgId, threadId);
  return { audit, thread: finalThread ?? null, mailboxHealth, storedProviderMessageIds: persistedIds };
}

// ─── Audit lookups ───────────────────────────────────────────────────────────

export async function getThreadCaptureAuditHistory(
  orgId: string,
  threadId: string,
  limit = 5,
): Promise<ConversationThreadCaptureAudit[]> {
  return db.select().from(conversationThreadCaptureAudits)
    .where(and(
      eq(conversationThreadCaptureAudits.orgId, orgId),
      eq(conversationThreadCaptureAudits.threadId, threadId),
    ))
    .orderBy(desc(conversationThreadCaptureAudits.createdAt))
    .limit(limit);
}

export async function listThreadStoredProviderMessageIds(orgId: string, threadId: string): Promise<Array<{ providerMessageId: string; direction: string; createdAt: Date }>> {
  const rows = await db.select({
    providerMessageId: emailMessages.providerMessageId,
    direction: emailMessages.direction,
    createdAt: emailMessages.createdAt,
  }).from(emailMessages)
    .where(and(
      eq(emailMessages.orgId, orgId),
      eq(emailMessages.threadId, threadId),
      isNotNull(emailMessages.providerMessageId),
    ))
    .orderBy(emailMessages.createdAt);
  return rows
    .filter(r => r.providerMessageId)
    .map(r => ({ providerMessageId: r.providerMessageId!, direction: r.direction, createdAt: r.createdAt }));
}

// ─── Sweep across stuck threads ──────────────────────────────────────────────

export interface SweepResult {
  scanned: number;
  healed: number;
  threadsRecovered: number;
  errors: number;
  details: Array<{ threadId: string; persisted: number; rootCause: string }>;
}

export async function selfHealStuckThreads(opts: {
  orgId?: string;
  triggeredBy?: "scheduled" | "manual";
  minStuckMs?: number;
  maxThreads?: number;
  /** Skip threads with any audit row newer than this many ms (default 10 min). */
  recentAuditDedupeMs?: number;
  /** Cap number of threads per mailbox per sweep (default 25). */
  perMailboxLimit?: number;
  /** Restrict the sweep to threads owned by these mailboxes (Task #794). */
  mailboxIds?: string[];
} = {}): Promise<SweepResult> {
  const {
    orgId,
    triggeredBy = "scheduled",
    minStuckMs = 10 * 60 * 1000,
    maxThreads = 200,
    recentAuditDedupeMs = 10 * 60 * 1000,
    perMailboxLimit = 25,
    mailboxIds,
  } = opts;

  const cutoff = new Date(Date.now() - minStuckMs);
  const recentAuditCutoff = new Date(Date.now() - recentAuditDedupeMs);

  // Build candidate set: waiting_on_us threads with an owner whose monitored
  // mailbox is enabled, EXCLUDING threads that already have an audit row in
  // the last `recentAuditDedupeMs` (dedupe within a cycle).
  const candidates = await db.select({
    threadId: emailConversationThreads.threadId,
    orgId: emailConversationThreads.orgId,
    waitingSinceAt: emailConversationThreads.waitingSinceAt,
    mailboxId: monitoredMailboxes.id,
  })
    .from(emailConversationThreads)
    .innerJoin(monitoredMailboxes, and(
      eq(monitoredMailboxes.userId, emailConversationThreads.ownerUserId),
      eq(monitoredMailboxes.orgId, emailConversationThreads.orgId),
      eq(monitoredMailboxes.enabled, true),
    ))
    .where(and(
      eq(emailConversationThreads.waitingState, "waiting_on_us"),
      orgId ? eq(emailConversationThreads.orgId, orgId) : drizzleSql`true`,
      mailboxIds && mailboxIds.length > 0
        ? drizzleSql`${monitoredMailboxes.id} = ANY(${mailboxIds})`
        : drizzleSql`true`,
      drizzleSql`(${emailConversationThreads.waitingSinceAt} IS NULL OR ${emailConversationThreads.waitingSinceAt} < ${cutoff})`,
      // Dedupe: skip threads already healed/checked very recently. When
      // recentAuditDedupeMs is 0 (e.g. callers that just kicked off a manual
      // recovery and want a fresh pass), the dedupe is disabled.
      recentAuditDedupeMs > 0
        ? drizzleSql`NOT EXISTS (
            SELECT 1 FROM conversation_thread_capture_audits a
            WHERE a.org_id = ${emailConversationThreads.orgId}
              AND a.thread_id = ${emailConversationThreads.threadId}
              AND a.created_at > ${recentAuditCutoff}
          )`
        : drizzleSql`true`,
    ))
    .limit(maxThreads);

  // Per-mailbox rate-limit so a single misconfigured mailbox can't burn the
  // whole Graph quota in one sweep.
  const perMailboxCount = new Map<string, number>();
  const queue: typeof candidates = [];
  for (const c of candidates) {
    const used = perMailboxCount.get(c.mailboxId) ?? 0;
    if (used >= perMailboxLimit) continue;
    perMailboxCount.set(c.mailboxId, used + 1);
    queue.push(c);
  }

  const result: SweepResult = { scanned: queue.length, healed: 0, threadsRecovered: 0, errors: 0, details: [] };

  for (const c of queue) {
    try {
      const r = await selfHealConversationThread({
        orgId: c.orgId,
        threadId: c.threadId,
        triggeredBy,
      });
      result.healed++;
      if (r.audit.messagesPersisted > 0) {
        result.threadsRecovered++;
      }
      result.details.push({
        threadId: c.threadId,
        persisted: r.audit.messagesPersisted,
        rootCause: r.audit.rootCauseLabel,
      });
    } catch (err) {
      result.errors++;
      log(`[sweep] thread=${c.threadId} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (result.threadsRecovered > 0 || result.errors > 0) {
    log(`Sweep: scanned=${result.scanned} recovered=${result.threadsRecovered} errors=${result.errors} mailboxes=${perMailboxCount.size}`);
  }
  return result;
}

// ─── Aggregated capture-audit health for the Conversations page pill ────────
// Task #536. Returns an at-a-glance health snapshot scoped to the mailboxes
// of a set of users (the caller's reporting tree, or the whole org for
// admins). Used to render the always-visible "All synced / Recovering /
// Issue" pill at the top of the Conversations page.

export type CaptureAuditOverallStatus = "healthy" | "recovering" | "unhealthy";

export interface CaptureAuditHealthRecentRun {
  id: string;
  threadId: string;
  triggeredBy: string;
  messagesFoundUpstream: number;
  messagesPersisted: number;
  rootCauseLabel: string;
  createdAt: string;
}

export interface CaptureAuditHealthAffectedThread {
  threadId: string;
  rootCauseLabel: string;
  messagesFoundUpstream: number;
  messagesPersisted: number;
  lastAuditAt: string;
}

/** Liveness state for one of the email-pipeline cron jobs. Surfaced on the
 * Capture Audit pill so admins can see "the renewer hasn't run in 9 hours"
 * before it turns into a Webhook Unhealthy red pill. */
export interface CronJobHealth {
  jobName: string;
  /** "ok" = recent successful tick. "stale" = no tick within the expected
   *  interval × graceFactor. "failing" = last tick errored or repeated
   *  failures. "unknown" = never ran (boot row not yet written). */
  status: "ok" | "stale" | "failing" | "unknown";
  expectedIntervalMs: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  nextExpectedAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface CaptureAuditHealthSnapshot {
  status: CaptureAuditOverallStatus;
  generatedAt: string;
  /** Last successful sync across the in-scope mailboxes (max of last
   * webhook delivery and last outbound captured). Null when no mailboxes
   * are visible to the caller. */
  lastSuccessfulSyncAt: string | null;
  pendingRecoveryThreadCount: number;
  webhookFailureCount: number;
  /** Task #997: explicit three-bucket discriminator for the popover.
   *  Counted server-side so every consumer (Conversations pill,
   *  external monitoring webhook, future Slack digest) agrees on the
   *  same numbers. The contract:
   *    - `actionRequired`  = `monitored_active` mailboxes whose
   *                          SentItems sub is NOT `active` — i.e. the
   *                          rows the admin must act on. Drives the
   *                          red Webhook Unhealthy pill.
   *    - `configIssues`    = `invalid_config` mailboxes. Surfaced for
   *                          visibility but never inflates `actionRequired`
   *                          and never auto-pages.
   *    - `excluded`        = `excluded_intentional` + `disabled`.
   *                          Surfaced for transparency only.
   *    - `healthyActive`   = `monitored_active` rows whose SentItems
   *                          sub is `active`. The "Show N healthy"
   *                          expander is driven off this.
   *  `actionRequired` is the count behind `webhookFailureCount`'s
   *  status-rolling logic. Sum of the four equals `scope.mailboxes`. */
  mailboxBuckets: {
    actionRequired: number;
    configIssues: number;
    excluded: number;
    healthyActive: number;
  };
  scope: { mailboxes: number; users: number | null };
  mailboxes: MailboxHealthSnapshot[];
  recentRuns: CaptureAuditHealthRecentRun[];
  affectedThreads: CaptureAuditHealthAffectedThread[];
  /** Liveness for the email-pipeline cron jobs. Status rolls into the
   * pill's overall status: any "stale" or "failing" job upgrades to
   * "unhealthy". */
  cronJobs: CronJobHealth[];
  /**
   * Shared reply-tracking mailbox health (the OUTLOOK_REPLY_EMAIL inbox
   * carriers reply into). `null` when the org doesn't have Azure (Graph)
   * credentials configured at all — there is no shared mailbox to report
   * on. When non-null, a `configured && !enabled` state rolls the overall
   * pill into `unhealthy` so a silently re-init-failed shared subscription
   * is visible without admins having to open the carrier outreach panel.
   */
  sharedReplyMailbox: {
    configured: boolean;
    enabled: boolean;
    subscriptionActive: boolean;
    mailbox: string | null;
    missingPermissions: string[];
    warnings: string[];
  } | null;
}

/** Root-cause labels that mean "this thread still has an unresolved
 * capture problem" — i.e. the rep should look at it. `nothing_missing`
 * and successful recoveries are not surfaced in the affected list. */
const UNRESOLVED_ROOT_CAUSES = new Set([
  "webhook_dropped",
  "webhook_never_fired",
  "subscription_expired",
  "sentitems_subscription_missing",
  "mailbox_disabled",
  "mailbox_missing",
  "delta_stale",
  "error",
]);

const DEFAULT_HEALTH_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export async function getCaptureAuditHealthForUsers(opts: {
  orgId: string;
  /** When null the caller has org-wide visibility (admin). When a list is
   * passed only mailboxes owned by these users are inspected. */
  visibleUserIds: string[] | null;
  lookbackMs?: number;
  recentRunsLimit?: number;
  affectedThreadsLimit?: number;
}): Promise<CaptureAuditHealthSnapshot> {
  const lookbackMs = opts.lookbackMs ?? DEFAULT_HEALTH_LOOKBACK_MS;
  const recentRunsLimit = opts.recentRunsLimit ?? 10;
  const affectedThreadsLimit = opts.affectedThreadsLimit ?? 25;
  const since = new Date(Date.now() - lookbackMs);

  // 1. Resolve visible mailboxes for the caller. Reps see only their own;
  //    managers see their reporting tree's mailboxes; admins see all.
  const allMailboxes = await db.select().from(monitoredMailboxes)
    .where(eq(monitoredMailboxes.orgId, opts.orgId));
  const visibleMailboxes = opts.visibleUserIds === null
    ? allMailboxes
    : allMailboxes.filter(m => opts.visibleUserIds!.includes(m.userId));
  const mailboxIds = visibleMailboxes.map(m => m.id);

  const mailboxHealth = visibleMailboxes.map(getMailboxSentItemsHealth);
  // Task #997: failure/stale counters MUST scope to monitored_active rows
  // only. Non-active modes already classify as `unknown` (see the
  // monitor-mode short-circuit in `getMailboxSentItemsHealth`), but
  // gating the filter explicitly here makes the contract obvious to
  // future readers and ensures a regression in the classifier can't
  // silently re-pollute the counters.
  const webhookFailureCount = mailboxHealth.filter(h =>
    h.monitorMode === "monitored_active" &&
    (h.sentItemsHealth === "expired" || h.sentItemsHealth === "missing"),
  ).length;
  const staleCount = mailboxHealth.filter(h =>
    h.monitorMode === "monitored_active" && h.sentItemsHealth === "stale",
  ).length;

  // Task #997: explicit three-bucket counters surfaced on the snapshot.
  // The popover groups its rendered list by these same buckets; counting
  // them server-side guarantees the pill summary line and the popover
  // sections agree on the numbers.
  const mailboxBuckets = {
    actionRequired: mailboxHealth.filter(h =>
      h.monitorMode === "monitored_active" && h.sentItemsHealth !== "active",
    ).length,
    configIssues: mailboxHealth.filter(h => h.monitorMode === "invalid_config").length,
    excluded: mailboxHealth.filter(h =>
      h.monitorMode === "excluded_intentional" || h.monitorMode === "disabled",
    ).length,
    healthyActive: mailboxHealth.filter(h =>
      h.monitorMode === "monitored_active" && h.sentItemsHealth === "active",
    ).length,
  };

  const lastSuccessfulSyncAt = visibleMailboxes.reduce<Date | null>((acc, m) => {
    // Task #794: include lastSyncAt so the pill flips green right after a
    // successful manual renewal/backfill cycle (which always pumps lastSyncAt
    // via syncMailboxDelta), without having to wait for a real outbound to
    // happen on the mailbox.
    const candidates = [m.lastSentItemsNotificationAt, m.lastOutboundCapturedAt, m.lastSyncAt]
      .filter((d): d is Date => !!d);
    if (candidates.length === 0) return acc;
    const best = candidates.reduce((a, b) => (a > b ? a : b));
    return acc && acc > best ? acc : best;
  }, null);

  // 2. Pull recent audit rows scoped to the visible mailboxes (or all when
  //    visibility is org-wide). Joining on mailboxId is the cleanest scope
  //    because every audit row records the mailbox at the time of the run.
  let recentAuditsRaw: ConversationThreadCaptureAudit[] = [];
  if (opts.visibleUserIds === null || mailboxIds.length > 0) {
    const baseQuery = db.select().from(conversationThreadCaptureAudits)
      .where(and(
        eq(conversationThreadCaptureAudits.orgId, opts.orgId),
        gte(conversationThreadCaptureAudits.createdAt, since),
        opts.visibleUserIds === null
          ? drizzleSql`true`
          : drizzleSql`${conversationThreadCaptureAudits.mailboxId} = ANY(${mailboxIds})`,
      ))
      .orderBy(desc(conversationThreadCaptureAudits.createdAt))
      .limit(200);
    recentAuditsRaw = await baseQuery;
  }

  // 3. Collapse to one entry per thread (most recent audit wins) so the
  //    "affected" list doesn't show the same thread N times.
  const latestPerThread = new Map<string, ConversationThreadCaptureAudit>();
  for (const a of recentAuditsRaw) {
    if (!latestPerThread.has(a.threadId)) latestPerThread.set(a.threadId, a);
  }

  const affectedThreads: CaptureAuditHealthAffectedThread[] = [];
  for (const a of latestPerThread.values()) {
    if (UNRESOLVED_ROOT_CAUSES.has(a.rootCauseLabel)) {
      affectedThreads.push({
        threadId: a.threadId,
        rootCauseLabel: a.rootCauseLabel,
        messagesFoundUpstream: a.messagesFoundUpstream,
        messagesPersisted: a.messagesPersisted,
        lastAuditAt: a.createdAt.toISOString(),
      });
    }
  }
  affectedThreads.sort((a, b) => (a.lastAuditAt > b.lastAuditAt ? -1 : 1));
  const trimmedAffected = affectedThreads.slice(0, affectedThreadsLimit);

  const recentRuns: CaptureAuditHealthRecentRun[] = recentAuditsRaw
    .slice(0, recentRunsLimit)
    .map(a => ({
      id: a.id,
      threadId: a.threadId,
      triggeredBy: a.triggeredBy,
      messagesFoundUpstream: a.messagesFoundUpstream,
      messagesPersisted: a.messagesPersisted,
      rootCauseLabel: a.rootCauseLabel,
      createdAt: a.createdAt.toISOString(),
    }));

  // 4. Cron-job liveness for the email pipeline. Any "stale" or "failing"
  //    job upgrades the overall pill to "unhealthy" — the whole point of
  //    the heartbeat layer is that a silently-dead cron is treated with the
  //    same urgency as a webhook expiry.
  const allHeartbeats = await storage.getCronHeartbeats();
  const staleHeartbeats = await storage.getStaleCronHeartbeats(1.5);
  const staleNames = new Set(staleHeartbeats.map(s => s.jobName));
  const cronJobs: CronJobHealth[] = Array.from(EMAIL_PIPELINE_JOBS).map(jobName => {
    const row = allHeartbeats.find(h => h.jobName === jobName);
    if (!row) {
      return {
        jobName,
        status: "unknown",
        expectedIntervalMs: 0,
        lastStartedAt: null,
        lastFinishedAt: null,
        nextExpectedAt: null,
        consecutiveFailures: 0,
        lastError: null,
      };
    }
    let s: CronJobHealth["status"] = "ok";
    if (staleNames.has(row.jobName)) s = "stale";
    else if (row.lastStatus === "error" || row.consecutiveFailures > 0) s = "failing";
    return {
      jobName: row.jobName,
      status: s,
      expectedIntervalMs: row.expectedIntervalMs,
      lastStartedAt: row.lastStartedAt?.toISOString() ?? null,
      lastFinishedAt: row.lastFinishedAt?.toISOString() ?? null,
      nextExpectedAt: row.nextExpectedAt?.toISOString() ?? null,
      consecutiveFailures: row.consecutiveFailures,
      lastError: row.lastError,
    };
  });
  // Split cron health into two tiers (Issue #2026-04-28):
  //   - critical-job staleness/failure → "unhealthy" (red)
  //   - any other email-pipeline-job staleness/failure → "recovering" (amber)
  // The previous "any stale heartbeat → unhealthy" rule produced a recurring
  // false-positive red pill whenever a 6-hourly subscription renewer was
  // briefly behind, even though Graph subs survive ~70h and missing one
  // tick is not user-visible. Reserving red for the fast-cadence jobs
  // whose silence directly translates to mail starvation keeps the badge
  // meaningful.
  const cronCritical = cronJobs.some(
    c => CRITICAL_EMAIL_PIPELINE_JOBS.has(c.jobName as any)
      && (c.status === "stale" || c.status === "failing"),
  );
  const cronDegraded = cronJobs.some(c => c.status === "stale" || c.status === "failing");

  // 5. Shared reply-tracking mailbox. Reads in-process state from
  //    graphSubscriptionService — no external call. Surfaced as `null` when
  //    Azure creds aren't configured at all (the org doesn't have a shared
  //    mailbox to report on); otherwise surfaced with the same shape the
  //    /api/admin/graph-reply-status endpoint returns.
  const replyTracking = getReplyTrackingStatus();
  const hasAzureCreds = !!(
    process.env.OUTLOOK_TENANT_ID &&
    process.env.OUTLOOK_CLIENT_ID &&
    process.env.OUTLOOK_CLIENT_SECRET
  );
  const sharedReplyMailbox: CaptureAuditHealthSnapshot["sharedReplyMailbox"] = hasAzureCreds
    ? {
        configured: !!replyTracking.mailbox,
        enabled: replyTracking.enabled,
        subscriptionActive: replyTracking.subscriptionActive,
        mailbox: replyTracking.mailbox,
        missingPermissions: replyTracking.missingPermissions,
        warnings: replyTracking.warnings,
      }
    : null;
  // A shared mailbox that's *configured* but not *enabled* (Mail.Read
  // pending, webhook secret missing, subscription failed to register, etc.)
  // means carrier replies are silently NOT being captured. That's the same
  // operational severity as a per-rep mailbox subscription expiry, so it
  // rolls into the same "unhealthy" tier.
  const sharedReplyDegraded = !!(
    sharedReplyMailbox &&
    sharedReplyMailbox.configured &&
    !sharedReplyMailbox.enabled
  );

  // 6. Roll up to a single status. Unhealthy wins over recovering.
  let status: CaptureAuditOverallStatus = "healthy";
  if (webhookFailureCount > 0 || cronCritical || sharedReplyDegraded) {
    status = "unhealthy";
  } else if (affectedThreads.length > 0 || staleCount > 0 || cronDegraded) {
    status = "recovering";
  }

  return {
    status,
    generatedAt: new Date().toISOString(),
    lastSuccessfulSyncAt: lastSuccessfulSyncAt ? lastSuccessfulSyncAt.toISOString() : null,
    pendingRecoveryThreadCount: affectedThreads.length,
    webhookFailureCount,
    mailboxBuckets,
    scope: { mailboxes: visibleMailboxes.length, users: opts.visibleUserIds?.length ?? null },
    mailboxes: mailboxHealth,
    recentRuns,
    affectedThreads: trimmedAffected,
    cronJobs,
    sharedReplyMailbox,
  };
}

// ─── Periodic scheduler ──────────────────────────────────────────────────────

// Cron-anchored every 5 minutes. The previous setInterval(5min) reset on
// every workflow restart, so a workflow that flapped multiple times within
// 5 min could go a long time without sweeping. Heartbeated so a silently-
// dead sweeper is observable from the Capture Audit pill.
let _sweepTimer: ReturnType<typeof cron.schedule> | null = null;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function initReplyCaptureSelfHealScheduler(): void {
  if (!azureCredentialsConfigured()) {
    log("Azure credentials not configured — reply-capture self-heal disabled");
    return;
  }

  setTimeout(() => {
    selfHealStuckThreads({ triggeredBy: "scheduled" }).catch(err => {
      log(`scheduler initial sweep error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, 60_000);

  // Note: the task's RIM26016883 incident is repaired by the periodic
  // sweep above (the thread is "Waiting on us" and matches the candidate
  // query). No incident-specific startup logic is needed — the generic
  // mechanism is the durable answer.

  if (_sweepTimer) _sweepTimer.stop();
  _sweepTimer = cron.schedule("*/5 * * * *", () => {
    void withHeartbeat(JOB_NAMES.replyCaptureSelfHealSweep, SWEEP_INTERVAL_MS, async () => {
      try {
        await selfHealStuckThreads({ triggeredBy: "scheduled" });
      } catch (err) {
        log(`scheduler sweep error: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  });
  log(`Reply-capture self-heal scheduler started (every ${Math.round(SWEEP_INTERVAL_MS / 60000)}m, clock-anchored)`);
}

export function stopReplyCaptureSelfHealScheduler(): void {
  if (_sweepTimer) {
    _sweepTimer.stop();
    _sweepTimer = null;
  }
}
