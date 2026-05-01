/**
 * Mailbox health watchdog (Task #867 — self-healing email ingestion).
 *
 * Runs every minute. For each enabled monitored mailbox:
 *   1. Classifies health (healthy / degraded / unhealthy) based on
 *      subscription expiry, time since last accepted webhook, and time
 *      since last successful sync.
 *   2. Auto-heals dead/expiring subscriptions by calling
 *      `renewSingleMailboxSubscription` (which already short-circuits on
 *      a per-mailbox renewal lock so we never race with the periodic
 *      renewer).
 *   3. Adapts `pollCadenceSeconds`:
 *        - healthy   → 300s (5min)  — webhooks carry the load
 *        - degraded  → 60s  (1min)  — pull more aggressively to mask
 *                                      partial webhook silence
 *        - unhealthy → 60s  (1min)  — same, until the sub is rescued
 *      The delta-sync cron runs every minute and gates per-mailbox on
 *      `now >= lastSyncAt + pollCadenceSeconds*1000`, so a healthy
 *      mailbox still only polls every 5 minutes.
 *   4. Fires a deduped admin notification (via mailbox_health_alerts)
 *      when a mailbox becomes unhealthy or its renewal fails repeatedly.
 *      Resolves the alert the next time the mailbox returns to healthy.
 *
 * The classifier is exported as a pure function for unit-testing, so we
 * can pin the exact thresholds without standing up a test database.
 */
import cron, { type ScheduledTask } from "node-cron";
import { and, eq } from "drizzle-orm";
import { storage, db } from "../storage";
import { users, type MonitoredMailbox } from "@shared/schema";
import { JOB_NAMES, withHeartbeat } from "../lib/cronHeartbeat";
import { renewSingleMailboxSubscription } from "../graphSubscriptionService";

function log(msg: string): void {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [mailbox-watchdog] ${msg}`);
}

// ── Tunables ────────────────────────────────────────────────────────────────
// Time since last accepted webhook beyond which we consider the channel
// "silent". Tuned slightly above Microsoft Graph's typical max push gap.
export const WEBHOOK_SILENCE_DEGRADED_MS = 30 * 60 * 1000; // 30 min
export const WEBHOOK_SILENCE_UNHEALTHY_MS = 90 * 60 * 1000; // 90 min
// Subscription expiry headroom: anything expiring in less than this is a
// renewal candidate even if the periodic renewer hasn't fired yet.
export const SUB_EXPIRY_HEADROOM_MS = 60 * 60 * 1000; // 1 hour
// Last-sync floor: a mailbox that hasn't synced in this long is unhealthy
// regardless of webhook activity, because the delta loop is the safety net.
export const LAST_SYNC_FLOOR_UNHEALTHY_MS = 30 * 60 * 1000; // 30 min
// Adaptive cadence values.
export const HEALTHY_POLL_CADENCE_S = 300;   // 5 min
export const DEGRADED_POLL_CADENCE_S = 60;   // 1 min

export type MailboxHealthStatus = "healthy" | "degraded" | "unhealthy";

export interface MailboxHealthClassification {
  status: MailboxHealthStatus;
  reason: string;
  recommendedPollCadenceS: number;
  /** True when at least one of (Inbox sub, SentItems sub) is missing or
   *  expiring inside the headroom — caller should self-heal. */
  needsResubscribe: boolean;
  /** Which sub(s) need resubscribing. */
  resubscribeReasons: string[];
}

/**
 * Pure classification function — no I/O, no clock import. Pass `now` so
 * unit tests can pin time. Centralized here so the watchdog and the
 * `/api/admin/mailbox-health` route surface identical labels.
 */
export function classifyMailboxHealth(
  mb: MonitoredMailbox,
  now: Date,
): MailboxHealthClassification {
  const reasons: string[] = [];
  const resubReasons: string[] = [];
  let needsResub = false;
  let unhealthy = false;
  let degraded = false;

  const nowMs = now.getTime();

  // Subscription presence + expiry — the most common silent-failure mode.
  if (!mb.subscriptionId) {
    needsResub = true;
    unhealthy = true;
    resubReasons.push("Inbox subscription missing");
    reasons.push("Inbox subscription missing");
  }
  if (!mb.sentItemsSubscriptionId) {
    needsResub = true;
    // Missing SentItems is degraded, not unhealthy — outbound capture
    // also has the delta-sync safety net for SentItems folder, so it's
    // less catastrophic than missing Inbox.
    degraded = true;
    resubReasons.push("SentItems subscription missing");
    reasons.push("SentItems subscription missing");
  }
  if (mb.subscriptionExpiresAt) {
    const msUntilExpiry = mb.subscriptionExpiresAt.getTime() - nowMs;
    if (msUntilExpiry <= 0) {
      needsResub = true;
      unhealthy = true;
      resubReasons.push("Subscription expired");
      reasons.push(`Subscription expired ${formatAgo(-msUntilExpiry)} ago`);
    } else if (msUntilExpiry <= SUB_EXPIRY_HEADROOM_MS) {
      needsResub = true;
      degraded = true;
      reasons.push(`Subscription expires in ${formatAgo(msUntilExpiry)}`);
    }
  }

  // Webhook silence — Inbox is the load-bearing one, SentItems is
  // secondary.
  const inboxSince = mb.lastInboxNotificationAt
    ? nowMs - mb.lastInboxNotificationAt.getTime()
    : null;
  if (inboxSince !== null) {
    if (inboxSince > WEBHOOK_SILENCE_UNHEALTHY_MS) {
      unhealthy = true;
      reasons.push(`No Inbox webhook in ${formatAgo(inboxSince)}`);
    } else if (inboxSince > WEBHOOK_SILENCE_DEGRADED_MS) {
      degraded = true;
      reasons.push(`No Inbox webhook in ${formatAgo(inboxSince)}`);
    }
  }

  const sentSince = mb.lastSentItemsNotificationAt
    ? nowMs - mb.lastSentItemsNotificationAt.getTime()
    : null;
  if (sentSince !== null && sentSince > WEBHOOK_SILENCE_UNHEALTHY_MS) {
    degraded = true;
    reasons.push(`No SentItems webhook in ${formatAgo(sentSince)}`);
  }

  // Last-sync floor — delta loop is the safety net; if even *that* is
  // dragging, we're not catching mail.
  const syncSince = mb.lastSyncAt ? nowMs - mb.lastSyncAt.getTime() : null;
  if (syncSince !== null && syncSince > LAST_SYNC_FLOOR_UNHEALTHY_MS) {
    unhealthy = true;
    reasons.push(`No successful sync in ${formatAgo(syncSince)}`);
  }

  // Repeated renewal failure — surfaced when the periodic renewer wrote
  // an error but no successful renewal followed.
  if (mb.lastSubscriptionRenewalError && !subRenewalLooksRecent(mb, nowMs)) {
    degraded = true;
    reasons.push(`Last renewal failed: ${mb.lastSubscriptionRenewalError.slice(0, 120)}`);
  }

  // Sync-status flag set by the existing delta-sync error path — if it's
  // already saying "error" we trust that and escalate.
  if (mb.syncStatus === "error") {
    unhealthy = true;
    if (mb.syncError) reasons.push(`Sync error: ${mb.syncError.slice(0, 120)}`);
  } else if (mb.syncStatus === "partial") {
    degraded = true;
    if (mb.syncError) reasons.push(`Partial sync: ${mb.syncError.slice(0, 120)}`);
  }

  const status: MailboxHealthStatus = unhealthy ? "unhealthy" : degraded ? "degraded" : "healthy";
  const cadence = status === "healthy" ? HEALTHY_POLL_CADENCE_S : DEGRADED_POLL_CADENCE_S;
  const reason = reasons.length === 0 ? "All channels healthy" : reasons.join("; ");
  return {
    status,
    reason,
    recommendedPollCadenceS: cadence,
    needsResubscribe: needsResub,
    resubscribeReasons: resubReasons,
  };
}

function subRenewalLooksRecent(mb: MonitoredMailbox, nowMs: number): boolean {
  // A successful subscription renewal is implied by the expiry being far
  // in the future and no error logged after it. Use a 2h grace so an old
  // transient error doesn't keep us in degraded forever.
  if (!mb.subscriptionExpiresAt) return false;
  const msUntilExpiry = mb.subscriptionExpiresAt.getTime() - nowMs;
  if (msUntilExpiry <= SUB_EXPIRY_HEADROOM_MS) return false;
  if (!mb.lastSubscriptionRenewalAt) return true;
  return mb.lastSubscriptionRenewalAt.getTime() > nowMs - 2 * 60 * 60 * 1000;
}

function formatAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

// ── Per-mailbox watchdog tick ───────────────────────────────────────────────

interface WatchdogOutcome {
  mailboxId: string;
  email: string;
  before: MailboxHealthStatus | null;
  after: MailboxHealthStatus;
  action: string;
  resubscribed: boolean;
  resubscribeError?: string;
}

async function runWatchdogForMailbox(mb: MonitoredMailbox, now: Date): Promise<WatchdogOutcome> {
  const cls = classifyMailboxHealth(mb, now);
  const before = (mb.healthStatus as MailboxHealthStatus | "unknown") === "unknown"
    ? null
    : (mb.healthStatus as MailboxHealthStatus);

  let action = "none";
  let resubscribed = false;
  let resubscribeError: string | undefined;

  if (cls.needsResubscribe) {
    const result = await renewSingleMailboxSubscription(mb.id).catch((err): { skipped: true; reason: string } => ({
      skipped: true,
      reason: err instanceof Error ? err.message : String(err),
    }));
    if ("skipped" in result && result.skipped) {
      resubscribeError = result.reason;
      action = "resubscribe_skipped";
    } else if ("outcome" in result) {
      if (result.outcome === "renewed" || result.outcome === "reregistered") {
        resubscribed = true;
        action = result.outcome === "reregistered" ? "resubscribed" : "renewed";
      } else {
        resubscribeError = result.syncError ?? "Renewal failed";
        action = "resubscribe_failed";
      }
    }
  }

  // Re-classify with fresh state if we just touched the subscriptions —
  // a successful renewal should immediately drop us out of the
  // "expiring soon" branch on this same tick.
  const after = resubscribed
    ? classifyMailboxHealth((await storage.getMonitoredMailbox(mb.id)) ?? mb, now)
    : cls;

  await storage.updateMonitoredMailbox(mb.id, {
    healthStatus: after.status,
    healthReason: after.reason,
    pollCadenceSeconds: after.recommendedPollCadenceS,
    lastWatchdogActionAt: now,
    lastWatchdogAction: action,
  }).catch(err => {
    log(`Failed to persist watchdog status for ${mb.email}: ${err instanceof Error ? err.message : String(err)}`);
  });

  await reconcileAlerts(mb, after, resubscribeError, now);

  if (after.status !== before || action !== "none") {
    log(`${mb.email}: ${before ?? "?"} → ${after.status} (action=${action}) — ${after.reason}`);
  }

  return {
    mailboxId: mb.id,
    email: mb.email,
    before,
    after: after.status,
    action,
    resubscribed,
    resubscribeError,
  };
}

const ALERT_KEY_UNHEALTHY = "mailbox_unhealthy";
const ALERT_KEY_RENEWAL_FAILED = "subscription_renewal_failed";

async function reconcileAlerts(
  mb: MonitoredMailbox,
  cls: MailboxHealthClassification,
  resubscribeError: string | undefined,
  now: Date,
): Promise<void> {
  // Mailbox-unhealthy alert — fired only when the watchdog can't fix it
  // itself in this tick (i.e., still unhealthy after attempted resub).
  if (cls.status === "unhealthy") {
    const result = await storage.fireMailboxHealthAlert({
      orgId: mb.orgId,
      mailboxId: mb.id,
      alertKey: ALERT_KEY_UNHEALTHY,
      severity: "critical",
      reason: cls.reason,
    }).catch(() => null);
    if (result?.isNew) {
      await fanOutAdminNotifications(mb, "Mailbox sync unhealthy", cls.reason).catch(() => {});
    }
  } else {
    await storage.resolveMailboxHealthAlert(mb.id, ALERT_KEY_UNHEALTHY).catch(() => {});
  }

  // Renewal-failed alert — separate channel because a transient renewal
  // failure can happen without the mailbox going fully unhealthy
  // (e.g., expiring-soon renewal flopped but the existing sub still
  // covers us for an hour).
  if (resubscribeError) {
    const result = await storage.fireMailboxHealthAlert({
      orgId: mb.orgId,
      mailboxId: mb.id,
      alertKey: ALERT_KEY_RENEWAL_FAILED,
      severity: "warning",
      reason: `Subscription renewal failed: ${resubscribeError}`,
    }).catch(() => null);
    if (result?.isNew) {
      await fanOutAdminNotifications(mb, "Mailbox subscription renewal failing", resubscribeError).catch(() => {});
    }
  } else if (cls.status === "healthy") {
    await storage.resolveMailboxHealthAlert(mb.id, ALERT_KEY_RENEWAL_FAILED).catch(() => {});
  }
}

async function fanOutAdminNotifications(mb: MonitoredMailbox, title: string, reason: string): Promise<void> {
  // Notify every admin in the org. We use the existing in-app
  // notifications channel (same one conversationsInboxAlerter writes to)
  // so admins see this alongside other operational alerts.
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.organizationId, mb.orgId)));
  for (const admin of admins) {
    await storage.createNotification({
      userId: admin.id,
      type: "mailbox_health",
      title: `${title}: ${mb.email}`,
      body: reason,
      link: "/admin/integrations-health",
      relatedId: mb.id,
    }).catch(() => {});
  }
}

// ── Cron scheduler ──────────────────────────────────────────────────────────

let _watchdogCron: ScheduledTask | null = null;
let _tickInFlight = false;

async function runWatchdogCycle(trigger: "boot" | "cron"): Promise<void> {
  if (_tickInFlight) {
    log(`Skipping ${trigger} cycle — previous cycle still running`);
    return;
  }
  _tickInFlight = true;
  try {
    const now = new Date();
    const mailboxes = await storage.getEnabledMonitoredMailboxes();
    if (mailboxes.length === 0) return;
    let unhealthy = 0;
    let degraded = 0;
    let healed = 0;
    for (const mb of mailboxes) {
      try {
        const out = await runWatchdogForMailbox(mb, now);
        if (out.after === "unhealthy") unhealthy++;
        else if (out.after === "degraded") degraded++;
        if (out.resubscribed) healed++;
      } catch (err) {
        log(`Tick for ${mb.email} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (trigger === "cron") {
      log(`Cycle done: ${mailboxes.length} mailbox(es), ${unhealthy} unhealthy, ${degraded} degraded, ${healed} self-healed`);
    }
  } finally {
    _tickInFlight = false;
  }
}

const ONE_MIN_MS = 60 * 1000;

export function initMailboxWatchdogScheduler(): void {
  if (_watchdogCron) return;
  // Boot kick: 45s after start so the delta-sync boot pass runs first
  // and we can read fresh `lastSyncAt` values from it.
  setTimeout(() => { void withHeartbeat(JOB_NAMES.mailboxHealthWatchdog, ONE_MIN_MS, () => runWatchdogCycle("boot")); }, 45_000);
  _watchdogCron = cron.schedule("* * * * *", () => {
    void withHeartbeat(JOB_NAMES.mailboxHealthWatchdog, ONE_MIN_MS, () => runWatchdogCycle("cron"));
  });
  log("Watchdog scheduler started (every 1 minute)");
}

export function stopMailboxWatchdogScheduler(): void {
  if (_watchdogCron) {
    _watchdogCron.stop();
    _watchdogCron = null;
  }
}

/**
 * On-demand one-shot evaluation used by the admin "Resubscribe" button so
 * the UI updates immediately instead of waiting for the next cron tick.
 */
export async function runWatchdogOnce(mailboxId: string): Promise<WatchdogOutcome | null> {
  const mb = await storage.getMonitoredMailbox(mailboxId);
  if (!mb) return null;
  return runWatchdogForMailbox(mb, new Date());
}
