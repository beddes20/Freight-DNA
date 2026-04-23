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

import { storage, db } from "../storage";
import {
  conversationThreadCaptureAudits,
  emailMessages,
  emailConversationThreads,
  monitoredMailboxes,
  type MonitoredMailbox,
  type ConversationThreadCaptureAudit,
  type EmailConversationThread,
} from "@shared/schema";
import { and, eq, desc, gte, isNotNull, sql as drizzleSql } from "drizzle-orm";
import { azureCredentialsConfigured, getGraphAccessToken } from "../graphService";

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

/** 24h staleness threshold for "no SentItems traffic seen". */
const SENTITEMS_STALE_MS = 24 * 60 * 60 * 1000;

export function getMailboxSentItemsHealth(mb: MonitoredMailbox): MailboxHealthSnapshot {
  const now = Date.now();
  let health: SentItemsHealth = "active";
  let reason = "SentItems subscription active";

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
    // We have a sub — but has it actually delivered anything in the last 24h?
    // Use lastSentItemsNotificationAt OR lastOutboundCapturedAt as the
    // "we saw traffic" signal (capture via delta also counts as healthy).
    const lastTraffic = Math.max(
      mb.lastSentItemsNotificationAt?.getTime() ?? 0,
      mb.lastOutboundCapturedAt?.getTime() ?? 0,
    );
    if (lastTraffic > 0 && now - lastTraffic > SENTITEMS_STALE_MS) {
      health = "stale";
      const ageHrs = Math.round((now - lastTraffic) / (60 * 60 * 1000));
      reason = `No SentItems traffic in ${ageHrs}h — webhook may be silently dropped`;
    } else if (lastTraffic === 0 && mb.createdAt && now - mb.createdAt.getTime() > SENTITEMS_STALE_MS) {
      health = "stale";
      reason = "Subscription registered but never delivered an outbound notification";
    }
  }

  return {
    mailboxId: mb.id,
    email: mb.email,
    enabled: mb.enabled,
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

                await processUserMailboxEmailForDelta({
                  orgId,
                  monitoredMailbox: { id: mailbox.id, userId: mailbox.userId, email: mailbox.email },
                  fromEmail,
                  fromName,
                  toEmail,
                  allToRecipients: [...allTo, ...allCc],
                  subject,
                  bodyPreview,
                  bodyFull: bodyFull.slice(0, 5000),
                  conversationId: threadId,
                  providerMessageId: msg.id,
                  receivedAt: sentAt,
                  mailboxEmail: mailbox.email,
                });

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
                log(`[self-heal] message ingest error msgId=${msg.id}: ${msgErr instanceof Error ? msgErr.message : String(msgErr)}`);
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
} = {}): Promise<SweepResult> {
  const {
    orgId,
    triggeredBy = "scheduled",
    minStuckMs = 10 * 60 * 1000,
    maxThreads = 200,
    recentAuditDedupeMs = 10 * 60 * 1000,
    perMailboxLimit = 25,
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
      drizzleSql`(${emailConversationThreads.waitingSinceAt} IS NULL OR ${emailConversationThreads.waitingSinceAt} < ${cutoff})`,
      // Dedupe: skip threads already healed/checked very recently.
      drizzleSql`NOT EXISTS (
        SELECT 1 FROM conversation_thread_capture_audits a
        WHERE a.org_id = ${emailConversationThreads.orgId}
          AND a.thread_id = ${emailConversationThreads.threadId}
          AND a.created_at > ${recentAuditCutoff}
      )`,
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

// ─── Periodic scheduler ──────────────────────────────────────────────────────

let _sweepTimer: ReturnType<typeof setInterval> | null = null;
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

  _sweepTimer = setInterval(() => {
    selfHealStuckThreads({ triggeredBy: "scheduled" }).catch(err => {
      log(`scheduler sweep error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, SWEEP_INTERVAL_MS);
  log(`Reply-capture self-heal scheduler started (every ${Math.round(SWEEP_INTERVAL_MS / 60000)}m)`);
}

export function stopReplyCaptureSelfHealScheduler(): void {
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
}
