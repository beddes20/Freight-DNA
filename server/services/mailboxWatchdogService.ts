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
import { and, eq, sql } from "drizzle-orm";
import { storage, db } from "../storage";
import { users, type MonitoredMailbox } from "@shared/schema";
import { JOB_NAMES, withHeartbeat } from "../lib/cronHeartbeat";
import { renewSingleMailboxSubscription } from "../graphSubscriptionService";
import {
  getLiveSyncAuthStats,
  getLastMailboxPublishAt,
} from "./liveSync";

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

// Task #939 — classification-lag thresholds. The inline classifier
// dispatcher targets <15s end-to-end; we treat anything beyond 60s as
// "behind". Single-tick spikes are common (large attachment, brief
// OpenAI 429) so we require TWO consecutive ticks to fire — at the 1-min
// watchdog cadence that's a guaranteed-2-minute persistent backlog,
// which is an unambiguous regression of the inline contract.
const CLASSIFICATION_LAG_WARN_SECONDS = 60;
const CLASSIFICATION_LAG_CONSECUTIVE_TICKS = 2;
const ALERT_KEY_CLASSIFICATION_LAG = "classification_lag";

// Per-org tracker so we don't fire on every transient blip. Lives at
// module scope: the watchdog cron is a singleton in this process. When
// an org returns to healthy lag (or has no monitored mailboxes) the
// counter is cleared and the open alert is resolved.
const _laggingTickCount: Map<string, number> = new Map();

/**
 * Per-org classification-lag check. Runs once per watchdog tick across
 * all orgs that have at least one enabled monitored mailbox. Fires the
 * `classification_lag` alert against the first enabled mailbox in the
 * org (the alert is org-scoped semantically, but the FK schema requires
 * a mailboxId — picking a stable anchor avoids creating multiple alerts
 * for the same condition).
 *
 * Exported for unit testing; do NOT call from production code paths
 * other than `runWatchdogCycle`.
 */
export async function runClassificationLagCheck(
  mailboxes: MonitoredMailbox[],
  now: Date,
): Promise<{
  orgsChecked: number;
  orgsLagging: number;
  alertsFired: number;
  alertsResolved: number;
}> {
  // Group enabled mailboxes by org so we anchor the alert + skip orgs
  // with no live mailboxes.
  const byOrg = new Map<string, MonitoredMailbox[]>();
  for (const mb of mailboxes) {
    if (!mb.enabled) continue;
    const arr = byOrg.get(mb.orgId) ?? [];
    arr.push(mb);
    byOrg.set(mb.orgId, arr);
  }

  let orgsLagging = 0;
  let alertsFired = 0;
  let alertsResolved = 0;

  for (const [orgId, orgMailboxes] of byOrg.entries()) {
    let lagInfo;
    try {
      lagInfo = await storage.getOldestUnprocessedInboundEmailAge(orgId);
    } catch (err) {
      log(`classification-lag query failed for org=${orgId}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const ageSec = lagInfo.ageSeconds ?? 0;
    const isLagging = ageSec >= CLASSIFICATION_LAG_WARN_SECONDS;
    const anchor = orgMailboxes[0]; // stable: getEnabledMonitoredMailboxes is ordered

    if (isLagging) {
      orgsLagging++;
      const next = (_laggingTickCount.get(orgId) ?? 0) + 1;
      _laggingTickCount.set(orgId, next);
      if (next >= CLASSIFICATION_LAG_CONSECUTIVE_TICKS) {
        const reason =
          `Inline email classifier lag: ${ageSec}s old (${lagInfo.backlogCount} unprocessed inbound) — ` +
          `the 2-min recovery cron should be draining this; check OpenAI/extraction errors.`;
        const result = await storage.fireMailboxHealthAlert({
          orgId,
          mailboxId: anchor.id,
          alertKey: ALERT_KEY_CLASSIFICATION_LAG,
          severity: "warning",
          reason,
        }).catch(() => null);
        if (result?.isNew) {
          alertsFired++;
          await fanOutAdminNotifications(
            anchor,
            "Email→quote pipeline classification lag",
            reason,
          ).catch(() => {});
        }
      }
    } else {
      // Healthy → clear the streak counter and resolve any open alert.
      if (_laggingTickCount.has(orgId)) {
        _laggingTickCount.delete(orgId);
      }
      const resolved = await storage
        .resolveMailboxHealthAlert(anchor.id, ALERT_KEY_CLASSIFICATION_LAG)
        .catch(() => null);
      if (resolved) alertsResolved++;
    }
  }

  return {
    orgsChecked: byOrg.size,
    orgsLagging,
    alertsFired,
    alertsResolved,
  };
}

// Test-only: reset internal lag tracker so tests don't leak between cases.
export function _resetClassificationLagTrackerForTests(): void {
  _laggingTickCount.clear();
}

// Test-only: expose thresholds so unit tests can pin to the same constants.
export const _CLASSIFICATION_LAG_THRESHOLDS_FOR_TESTS = {
  warnSeconds: CLASSIFICATION_LAG_WARN_SECONDS,
  consecutiveTicks: CLASSIFICATION_LAG_CONSECUTIVE_TICKS,
  alertKey: ALERT_KEY_CLASSIFICATION_LAG,
};

// ── Live-sync health (Task #951) ────────────────────────────────────────────
//
// Two failure modes — both invisible to the rep until they complain that
// "Conversations stopped updating":
//
//   1. live_sync_auth_failure — the SSE endpoint starts rejecting most/all
//      connection attempts. This is the exact regression caused by Clerk
//      Bearer + EventSource (no header support). We require ≥10 attempts
//      AND ≥90% failure inside the rolling 60s window to suppress noise on
//      low-traffic envs, and 2 consecutive ticks before paging admins.
//
//   2. live_sync_silent_stream — per-org. A mailbox just received a webhook
//      or completed a delta sync (lastInboxNotificationAt < 10min ago) but
//      we have observed no `mailbox_inbound`/`mailbox_outbound` publish for
//      that org during this process lifetime, or the most recent publish is
//      older than the most recent ingest by more than 5 minutes. Catches
//      future regressions where a write path forgets to call `publish()`.
const ALERT_KEY_LIVE_SYNC_AUTH = "live_sync_auth_failure";
const ALERT_KEY_LIVE_SYNC_SILENT = "live_sync_silent_stream";
const LIVE_SYNC_AUTH_MIN_ATTEMPTS = 10;
const LIVE_SYNC_AUTH_FAILURE_RATIO = 0.9;
const LIVE_SYNC_AUTH_CONSECUTIVE_TICKS = 2;
const LIVE_SYNC_INGEST_RECENCY_MS = 10 * 60 * 1000; // 10 min
const LIVE_SYNC_PUBLISH_STALE_MS = 5 * 60 * 1000; // 5 min
const LIVE_SYNC_SILENT_CONSECUTIVE_TICKS = 2;

const _liveSyncAuthFailingTicks = { count: 0 };
const _liveSyncSilentTickCount: Map<string, number> = new Map();

export async function runLiveSyncHealthCheck(
  mailboxes: MonitoredMailbox[],
  now: Date,
): Promise<{
  authFailing: boolean;
  authStats: ReturnType<typeof getLiveSyncAuthStats>;
  orgsChecked: number;
  orgsSilent: number;
  alertsFired: number;
  alertsResolved: number;
}> {
  const nowMs = now.getTime();
  const stats = getLiveSyncAuthStats(nowMs);

  // Group enabled mailboxes by org — same anchoring strategy as the
  // classification-lag check (alert is org-scoped, schema needs a mailbox).
  const byOrg = new Map<string, MonitoredMailbox[]>();
  for (const mb of mailboxes) {
    if (!mb.enabled) continue;
    const arr = byOrg.get(mb.orgId) ?? [];
    arr.push(mb);
    byOrg.set(mb.orgId, arr);
  }

  let alertsFired = 0;
  let alertsResolved = 0;
  let orgsSilent = 0;

  // ── 1. Auth-failure check (process-wide signal, fanned out per org) ─────
  const authFailing =
    stats.total >= LIVE_SYNC_AUTH_MIN_ATTEMPTS &&
    stats.failureRatio >= LIVE_SYNC_AUTH_FAILURE_RATIO;
  if (authFailing) {
    _liveSyncAuthFailingTicks.count += 1;
  } else {
    _liveSyncAuthFailingTicks.count = 0;
  }
  const shouldFireAuth =
    _liveSyncAuthFailingTicks.count >= LIVE_SYNC_AUTH_CONSECUTIVE_TICKS;

  for (const [orgId, orgMailboxes] of byOrg.entries()) {
    const anchor = orgMailboxes[0];

    if (shouldFireAuth) {
      const reason =
        `Live-sync stream is rejecting ${stats.failure}/${stats.total} ` +
        `connection attempts in the last ${Math.round(stats.windowMs / 1000)}s ` +
        `(${Math.round(stats.failureRatio * 100)}% failure rate). ` +
        `Reps will fall back to the 120s background poll until this clears — ` +
        `check Clerk JWT validation and the ?token= query path.`;
      const result = await storage.fireMailboxHealthAlert({
        orgId,
        mailboxId: anchor.id,
        alertKey: ALERT_KEY_LIVE_SYNC_AUTH,
        severity: "critical",
        reason,
      }).catch(() => null);
      if (result?.isNew) {
        alertsFired++;
        await fanOutAdminNotifications(
          anchor,
          "Live-sync stream rejecting connections",
          reason,
        ).catch(() => {});
      }
    } else if (!authFailing) {
      // Resolve only when the *current* tick is healthy — keeps a flapping
      // condition pinned as open until it stabilizes.
      const resolved = await storage
        .resolveMailboxHealthAlert(anchor.id, ALERT_KEY_LIVE_SYNC_AUTH)
        .catch(() => null);
      if (resolved) alertsResolved++;
    }

    // ── 2. Silent-stream check (per org) ──────────────────────────────────
    // Use the freshest mailbox notification across the org's mailboxes as
    // the "ingest recently happened" signal. If no mailbox in this org has
    // ever received a notification, skip — there's nothing to be silent
    // about.
    let latestIngestMs = 0;
    for (const mb of orgMailboxes) {
      const t = mb.lastInboxNotificationAt?.getTime() ?? 0;
      if (t > latestIngestMs) latestIngestMs = t;
    }
    if (latestIngestMs === 0) {
      // No ingest ever — no silent-stream signal to evaluate.
      _liveSyncSilentTickCount.delete(orgId);
      await storage
        .resolveMailboxHealthAlert(anchor.id, ALERT_KEY_LIVE_SYNC_SILENT)
        .catch(() => null);
      continue;
    }
    const ingestRecent = nowMs - latestIngestMs <= LIVE_SYNC_INGEST_RECENCY_MS;
    const lastPub = getLastMailboxPublishAt(orgId);
    // Silent iff: ingest happened recently AND (no publish ever, OR last
    // publish is meaningfully older than last ingest). The 5min slack
    // tolerates one missed cron tick without paging.
    const isSilent =
      ingestRecent &&
      (lastPub === null || latestIngestMs - lastPub > LIVE_SYNC_PUBLISH_STALE_MS);
    if (isSilent) {
      orgsSilent++;
      const next = (_liveSyncSilentTickCount.get(orgId) ?? 0) + 1;
      _liveSyncSilentTickCount.set(orgId, next);
      if (next >= LIVE_SYNC_SILENT_CONSECUTIVE_TICKS) {
        const lastPubLabel = lastPub
          ? `${Math.round((nowMs - lastPub) / 1000)}s ago`
          : "never (during this process)";
        const reason =
          `Mailbox ingest fired ${Math.round((nowMs - latestIngestMs) / 1000)}s ` +
          `ago but the live-sync mailbox_inbound/_outbound publish is stale ` +
          `(last publish: ${lastPubLabel}). A write path likely dropped ` +
          `its publish() call — Conversations will not auto-update for this org.`;
        const result = await storage.fireMailboxHealthAlert({
          orgId,
          mailboxId: anchor.id,
          alertKey: ALERT_KEY_LIVE_SYNC_SILENT,
          severity: "warning",
          reason,
        }).catch(() => null);
        if (result?.isNew) {
          alertsFired++;
          await fanOutAdminNotifications(
            anchor,
            "Live-sync silent despite recent mailbox activity",
            reason,
          ).catch(() => {});
        }
      }
    } else {
      if (_liveSyncSilentTickCount.has(orgId)) {
        _liveSyncSilentTickCount.delete(orgId);
      }
      const resolved = await storage
        .resolveMailboxHealthAlert(anchor.id, ALERT_KEY_LIVE_SYNC_SILENT)
        .catch(() => null);
      if (resolved) alertsResolved++;
    }
  }

  return {
    authFailing,
    authStats: stats,
    orgsChecked: byOrg.size,
    orgsSilent,
    alertsFired,
    alertsResolved,
  };
}

// Test-only: clear all live-sync watchdog tracker state.
export function _resetLiveSyncHealthTrackerForTests(): void {
  _liveSyncAuthFailingTicks.count = 0;
  _liveSyncSilentTickCount.clear();
}

// Test-only: thresholds so unit tests can pin them.
export const _LIVE_SYNC_HEALTH_THRESHOLDS_FOR_TESTS = {
  authMinAttempts: LIVE_SYNC_AUTH_MIN_ATTEMPTS,
  authFailureRatio: LIVE_SYNC_AUTH_FAILURE_RATIO,
  authConsecutiveTicks: LIVE_SYNC_AUTH_CONSECUTIVE_TICKS,
  ingestRecencyMs: LIVE_SYNC_INGEST_RECENCY_MS,
  publishStaleMs: LIVE_SYNC_PUBLISH_STALE_MS,
  silentConsecutiveTicks: LIVE_SYNC_SILENT_CONSECUTIVE_TICKS,
  alertKeyAuth: ALERT_KEY_LIVE_SYNC_AUTH,
  alertKeySilent: ALERT_KEY_LIVE_SYNC_SILENT,
};

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

// ── Quote-pipeline health (Task #952) ───────────────────────────────────────
//
// Two failure modes — both invisible until a customer asks "where's my quote?":
//
//   1. quote_pipeline_zero_capture — per-org. Inbound customer email
//      volume is non-trivial in the trailing 60-min window but ZERO
//      quotes were ingested. Prior to Task #952 the only signal was the
//      rep noticing missing rows in /quote-requests; we now record
//      every drop in `quote_pipeline_drops`, and the simplest health
//      signal is "are we ingesting anything at all?". 2 consecutive
//      ticks before paging to suppress weekend/quiet-period noise.
//
//   2. quote_pipeline_classifier_outage — per-org. The fraction of
//      inbound customer messages dropped as `classifier_miss` or
//      `exception` exceeds the warn threshold over the trailing window
//      AND the absolute count is non-trivial. This catches a regression
//      in the OpenAI prompt/model swap that quietly turns most
//      pricing_request emails into status_update misses.
//
// Both probes use `quote_pipeline_drops.attempted_at` as their time axis
// (not message receivedAt) so that a backfill replay doesn't trigger a
// historical alert. The min-volume gates keep low-traffic orgs silent.
const ALERT_KEY_QUOTE_ZERO_CAPTURE = "quote_pipeline_zero_capture";
const ALERT_KEY_QUOTE_CLASSIFIER_OUTAGE = "quote_pipeline_classifier_outage";
const QUOTE_PIPELINE_WINDOW_MIN = 60;
// Task #969 — scaled inbound floor. The original `MIN_INBOUND_FOR_ALERT`
// constant (5) silenced low-traffic orgs but caused noisy pages on high-
// volume orgs whose 5-email lull in a 60-min window was within normal
// variance. The threshold now scales with the org's 7-day average daily
// inbound:
//
//   threshold = max(WATCHDOG_FLOOR, 0.05 * sevenDayAvgDaily)
//
// For a 400-emails/day org this lifts the trigger to 20 inbound in the
// window; for a 50-emails/day org it stays at the floor of 5. The rule
// that fired (`floor` or `scaled`) is named in the alert reason so the
// on-call admin can sanity-check whether the page is real signal.
const QUOTE_PIPELINE_WATCHDOG_FLOOR = 5;
const QUOTE_PIPELINE_SEVEN_DAY_FRACTION = 0.05;
const QUOTE_PIPELINE_CLASSIFIER_MISS_RATIO = 0.5;       // ≥50% of inbound dropped as miss/exception
const QUOTE_PIPELINE_MIN_DROPS_FOR_OUTAGE = 5;          // and ≥5 absolute
const QUOTE_PIPELINE_CONSECUTIVE_TICKS = 2;

/**
 * Resolve the inbound-volume threshold for the given org based on its
 * trailing 7-day average daily inbound. Pure-functional so unit tests
 * can pin both the floor and scaled branches deterministically.
 *
 * Returns:
 *   - `value`: the integer threshold to compare 60-min inbound against
 *   - `rule`:  which branch produced it — `"floor"` or `"scaled"`
 *   - `sevenDayAvgDaily`: the per-day average used for the scaled branch
 *
 * The value is rounded up so a fractional 5%-of-avg never silently rounds
 * down to a smaller-than-floor number.
 */
export function resolveQuotePipelineThreshold(
  sevenDayAvgDaily: number,
): { value: number; rule: "floor" | "scaled"; sevenDayAvgDaily: number } {
  const safeAvg = Math.max(0, Number.isFinite(sevenDayAvgDaily) ? sevenDayAvgDaily : 0);
  const scaled = Math.ceil(QUOTE_PIPELINE_SEVEN_DAY_FRACTION * safeAvg);
  if (scaled > QUOTE_PIPELINE_WATCHDOG_FLOOR) {
    return { value: scaled, rule: "scaled", sevenDayAvgDaily: safeAvg };
  }
  return { value: QUOTE_PIPELINE_WATCHDOG_FLOOR, rule: "floor", sevenDayAvgDaily: safeAvg };
}

const _quoteZeroCaptureTickCount: Map<string, number> = new Map();
const _quoteClassifierOutageTickCount: Map<string, number> = new Map();

export async function runQuotePipelineHealthCheck(
  mailboxes: MonitoredMailbox[],
  now: Date,
): Promise<{
  orgsChecked: number;
  orgsZeroCapture: number;
  orgsClassifierOutage: number;
  alertsFired: number;
  alertsResolved: number;
}> {
  // Anchor on the first enabled mailbox per org — same convention as the
  // classification-lag and live-sync checks, since alerts are org-scoped
  // semantically but require a mailboxId in schema.
  const byOrg = new Map<string, MonitoredMailbox[]>();
  for (const mb of mailboxes) {
    if (!mb.enabled) continue;
    const arr = byOrg.get(mb.orgId) ?? [];
    arr.push(mb);
    byOrg.set(mb.orgId, arr);
  }

  let orgsZeroCapture = 0;
  let orgsClassifierOutage = 0;
  let alertsFired = 0;
  let alertsResolved = 0;

  for (const [orgId, orgMailboxes] of byOrg.entries()) {
    const anchor = orgMailboxes[0];
    let metrics: {
      inboundCustomer: number;
      ingested: number;
      classifierMiss: number;
      exception: number;
      sevenDayAvgDaily: number;
    };
    try {
      const result = await db.execute(sql`
        SELECT
          (SELECT COUNT(*)::int FROM email_messages
            WHERE org_id = ${orgId}
              AND direction = 'inbound'
              AND COALESCE(provider_sent_at, created_at) >= now() - (${QUOTE_PIPELINE_WINDOW_MIN}::text || ' minutes')::interval
          ) AS inbound_customer,
          (SELECT COUNT(*)::int FROM quote_opportunities
            WHERE organization_id = ${orgId}
              AND source = 'email'
              AND created_at >= now() - (${QUOTE_PIPELINE_WINDOW_MIN}::text || ' minutes')::interval
          ) AS ingested,
          (SELECT COUNT(*)::int FROM quote_pipeline_drops
            WHERE org_id = ${orgId}
              AND reason_code = 'classifier_miss'
              AND attempted_at >= now() - (${QUOTE_PIPELINE_WINDOW_MIN}::text || ' minutes')::interval
          ) AS classifier_miss,
          (SELECT COUNT(*)::int FROM quote_pipeline_drops
            WHERE org_id = ${orgId}
              AND reason_code = 'exception'
              AND attempted_at >= now() - (${QUOTE_PIPELINE_WINDOW_MIN}::text || ' minutes')::interval
          ) AS exception,
          -- Task #969 — 7-day rolling average daily inbound, used to
          -- scale the watchdog threshold. We divide the trailing 7d
          -- count by 7 (rather than the more-correct distinct-day
          -- count) because a quiet weekend still belongs in the avg
          -- — the watchdog should pause for low-traffic periods, not
          -- just low-traffic days.
          (SELECT COUNT(*)::numeric / 7.0 FROM email_messages
            WHERE org_id = ${orgId}
              AND direction = 'inbound'
              AND COALESCE(provider_sent_at, created_at) >= now() - INTERVAL '7 days'
          ) AS seven_day_avg_daily
      `);
      const row = (result.rows?.[0] ?? {}) as Record<string, number | string | null>;
      metrics = {
        inboundCustomer: Number(row.inbound_customer ?? 0),
        ingested: Number(row.ingested ?? 0),
        classifierMiss: Number(row.classifier_miss ?? 0),
        exception: Number(row.exception ?? 0),
        sevenDayAvgDaily: Number(row.seven_day_avg_daily ?? 0),
      };
    } catch (err) {
      log(`quote-pipeline metrics query failed for org=${orgId}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // ── 1. Zero-capture: meaningful inbound, but zero ingests. ────────────
    // Task #969 — `meaningful` is now scaled to the org's 7-day baseline.
    const threshold = resolveQuotePipelineThreshold(metrics.sevenDayAvgDaily);
    const zeroCapture =
      metrics.inboundCustomer >= threshold.value &&
      metrics.ingested === 0;
    if (zeroCapture) {
      orgsZeroCapture++;
      const next = (_quoteZeroCaptureTickCount.get(orgId) ?? 0) + 1;
      _quoteZeroCaptureTickCount.set(orgId, next);
      if (next >= QUOTE_PIPELINE_CONSECUTIVE_TICKS) {
        const ruleSuffix =
          threshold.rule === "scaled"
            ? `Threshold rule: scaled (5% of 7-day avg ${threshold.sevenDayAvgDaily.toFixed(1)}/day = ${threshold.value}).`
            : `Threshold rule: floor (${threshold.value}).`;
        const reason =
          `Quote capture stalled: ${metrics.inboundCustomer} inbound email(s) in last ${QUOTE_PIPELINE_WINDOW_MIN} min ` +
          `but 0 quote opportunities ingested. Drops: ${metrics.classifierMiss} classifier_miss, ${metrics.exception} exception. ` +
          `${ruleSuffix} Inspect /admin/quote-pipeline-health.`;
        const result = await storage.fireMailboxHealthAlert({
          orgId,
          mailboxId: anchor.id,
          alertKey: ALERT_KEY_QUOTE_ZERO_CAPTURE,
          severity: "critical",
          reason,
        }).catch(() => null);
        if (result?.isNew) {
          alertsFired++;
          await fanOutAdminNotifications(
            anchor,
            "Customer-quote pipeline: zero capture",
            reason,
          ).catch(() => {});
        }
      }
    } else {
      if (_quoteZeroCaptureTickCount.has(orgId)) {
        _quoteZeroCaptureTickCount.delete(orgId);
      }
      const resolved = await storage
        .resolveMailboxHealthAlert(anchor.id, ALERT_KEY_QUOTE_ZERO_CAPTURE)
        .catch(() => null);
      if (resolved) alertsResolved++;
    }

    // ── 2. Classifier outage: high drop ratio AND absolute volume. ────────
    // Task #969 — same scaled inbound floor as zero-capture so the two
    // probes share the same "meaningful traffic" definition.
    const dropTotal = metrics.classifierMiss + metrics.exception;
    const dropRatio =
      metrics.inboundCustomer > 0 ? dropTotal / metrics.inboundCustomer : 0;
    const classifierOutage =
      metrics.inboundCustomer >= threshold.value &&
      dropTotal >= QUOTE_PIPELINE_MIN_DROPS_FOR_OUTAGE &&
      dropRatio >= QUOTE_PIPELINE_CLASSIFIER_MISS_RATIO;
    if (classifierOutage) {
      orgsClassifierOutage++;
      const next = (_quoteClassifierOutageTickCount.get(orgId) ?? 0) + 1;
      _quoteClassifierOutageTickCount.set(orgId, next);
      if (next >= QUOTE_PIPELINE_CONSECUTIVE_TICKS) {
        const pct = Math.round(dropRatio * 100);
        const ruleSuffix =
          threshold.rule === "scaled"
            ? `Threshold rule: scaled (5% of 7-day avg ${threshold.sevenDayAvgDaily.toFixed(1)}/day = ${threshold.value}).`
            : `Threshold rule: floor (${threshold.value}).`;
        const reason =
          `Classifier appears regressed: ${pct}% of inbound emails dropped ` +
          `(${metrics.classifierMiss} miss + ${metrics.exception} exception of ${metrics.inboundCustomer} inbound) in last ${QUOTE_PIPELINE_WINDOW_MIN} min. ` +
          `${ruleSuffix} Check OpenAI prompt/model + /admin/quote-pipeline-health.`;
        const result = await storage.fireMailboxHealthAlert({
          orgId,
          mailboxId: anchor.id,
          alertKey: ALERT_KEY_QUOTE_CLASSIFIER_OUTAGE,
          severity: "warning",
          reason,
        }).catch(() => null);
        if (result?.isNew) {
          alertsFired++;
          await fanOutAdminNotifications(
            anchor,
            "Customer-quote pipeline: classifier outage",
            reason,
          ).catch(() => {});
        }
      }
    } else {
      if (_quoteClassifierOutageTickCount.has(orgId)) {
        _quoteClassifierOutageTickCount.delete(orgId);
      }
      const resolved = await storage
        .resolveMailboxHealthAlert(anchor.id, ALERT_KEY_QUOTE_CLASSIFIER_OUTAGE)
        .catch(() => null);
      if (resolved) alertsResolved++;
    }
  }

  return {
    orgsChecked: byOrg.size,
    orgsZeroCapture,
    orgsClassifierOutage,
    alertsFired,
    alertsResolved,
  };
}

// Test-only: reset the per-org streak trackers.
export function _resetQuotePipelineTrackersForTests(): void {
  _quoteZeroCaptureTickCount.clear();
  _quoteClassifierOutageTickCount.clear();
}

export const _QUOTE_PIPELINE_THRESHOLDS_FOR_TESTS = {
  windowMin: QUOTE_PIPELINE_WINDOW_MIN,
  // Task #969 — `minInbound` is now derived; tests should use
  // `resolveQuotePipelineThreshold` to compute the expected value.
  watchdogFloor: QUOTE_PIPELINE_WATCHDOG_FLOOR,
  sevenDayFraction: QUOTE_PIPELINE_SEVEN_DAY_FRACTION,
  classifierMissRatio: QUOTE_PIPELINE_CLASSIFIER_MISS_RATIO,
  minDropsForOutage: QUOTE_PIPELINE_MIN_DROPS_FOR_OUTAGE,
  consecutiveTicks: QUOTE_PIPELINE_CONSECUTIVE_TICKS,
  alertKeyZeroCapture: ALERT_KEY_QUOTE_ZERO_CAPTURE,
  alertKeyClassifierOutage: ALERT_KEY_QUOTE_CLASSIFIER_OUTAGE,
};

// ── Ingestion-silent-drop & empty-content-spike (post-incident guardrails) ──
//
// These two checks would have alerted within the first hour of the May-2026
// inbound-email persistence incident (Graph webhooks kept delivering, but
// every row that landed in email_messages was outbound with empty content).
// They reuse the existing per-org streak gating so cross-tab alerts stay
// deduped, and they auto-resolve via the same storage primitives every other
// watchdog alert already uses.

const ALERT_KEY_INGESTION_SILENT_DROP = "ingestion_silent_drop";
const ALERT_KEY_EMPTY_CONTENT_SPIKE = "email_empty_content_spike";

// Window over which we compare Graph activity to inbound row landings. 30
// minutes is wide enough to absorb a slow delta cycle but tight enough to
// catch a real persistence regression before the bake-window expires.
const INGEST_DROP_WINDOW_MIN = 30;
// Don't alert on tiny windows — orgs with low mail volume would page
// every quiet evening. A handful of mailboxes must have actually fired
// notifications before we treat zero-rows as suspicious.
const INGEST_DROP_MIN_NOTIFICATIONS = 5;
const _ingestSilentDropTickCount = new Map<string, number>();

// Empty-content spike thresholds. 60-min window matches the org-wide
// observability surface; ratio is intentionally conservative so a single
// genuinely-empty notification email can't trip the alert.
const EMPTY_CONTENT_WINDOW_MIN = 60;
const EMPTY_CONTENT_MIN_VOLUME = 50;
const EMPTY_CONTENT_RATIO_THRESHOLD = 0.20;
const _emptyContentTickCount = new Map<string, number>();

export async function runIngestionSilentDropCheck(
  mailboxes: MonitoredMailbox[],
  now: Date,
): Promise<{ orgsChecked: number; orgsTripped: number; alertsFired: number; alertsResolved: number }> {
  const byOrg = new Map<string, MonitoredMailbox[]>();
  for (const mb of mailboxes) {
    if (!mb.enabled) continue;
    const arr = byOrg.get(mb.orgId) ?? [];
    arr.push(mb);
    byOrg.set(mb.orgId, arr);
  }

  let orgsTripped = 0;
  let alertsFired = 0;
  let alertsResolved = 0;
  const windowStart = new Date(now.getTime() - INGEST_DROP_WINDOW_MIN * 60_000);

  for (const [orgId, orgMailboxes] of byOrg.entries()) {
    const anchor = orgMailboxes[0];

    // "Graph activity" = mailboxes whose Inbox webhook fired inside the
    // window. We rely on the same `lastInboxNotificationAt` column the
    // graphWebhook handler stamps on every accepted notification, so the
    // signal is always in sync with the persister's input.
    const mailboxesActive = orgMailboxes.filter(
      mb => mb.lastInboxNotificationAt && mb.lastInboxNotificationAt >= windowStart,
    ).length;

    let inboundRowsInWindow = 0;
    try {
      const result = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM email_messages
        WHERE org_id = ${orgId}
          AND direction = 'inbound'
          AND created_at >= ${windowStart}
      `);
      const row = (result.rows?.[0] ?? {}) as { n?: number };
      inboundRowsInWindow = Number(row.n ?? 0);
    } catch (err) {
      log(`ingestion-silent-drop query failed org=${orgId}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const tripped =
      mailboxesActive >= INGEST_DROP_MIN_NOTIFICATIONS && inboundRowsInWindow === 0;

    if (tripped) {
      orgsTripped++;
      const next = (_ingestSilentDropTickCount.get(orgId) ?? 0) + 1;
      _ingestSilentDropTickCount.set(orgId, next);
      if (next >= QUOTE_PIPELINE_CONSECUTIVE_TICKS) {
        const reason =
          `Ingestion silent drop: ${mailboxesActive} mailbox(es) received Graph notifications ` +
          `in last ${INGEST_DROP_WINDOW_MIN} min but 0 inbound rows landed in email_messages. ` +
          `Likely persistence-layer regression — check graphWebhook + mailboxDeltaSyncService logs.`;
        const result = await storage
          .fireMailboxHealthAlert({
            orgId,
            mailboxId: anchor.id,
            alertKey: ALERT_KEY_INGESTION_SILENT_DROP,
            severity: "critical",
            reason,
          })
          .catch(() => null);
        if (result?.isNew) {
          alertsFired++;
          await fanOutAdminNotifications(
            anchor,
            "Email ingestion: silent drop",
            reason,
          ).catch(() => {});
        }
      }
    } else {
      _ingestSilentDropTickCount.delete(orgId);
      const resolved = await storage
        .resolveMailboxHealthAlert(anchor.id, ALERT_KEY_INGESTION_SILENT_DROP)
        .catch(() => null);
      if (resolved) alertsResolved++;
    }
  }

  return { orgsChecked: byOrg.size, orgsTripped, alertsFired, alertsResolved };
}

export async function runEmptyContentSpikeCheck(
  mailboxes: MonitoredMailbox[],
  now: Date,
): Promise<{ orgsChecked: number; orgsTripped: number; alertsFired: number; alertsResolved: number }> {
  const byOrg = new Map<string, MonitoredMailbox[]>();
  for (const mb of mailboxes) {
    if (!mb.enabled) continue;
    const arr = byOrg.get(mb.orgId) ?? [];
    arr.push(mb);
    byOrg.set(mb.orgId, arr);
  }

  let orgsTripped = 0;
  let alertsFired = 0;
  let alertsResolved = 0;
  const windowStart = new Date(now.getTime() - EMPTY_CONTENT_WINDOW_MIN * 60_000);

  for (const [orgId, orgMailboxes] of byOrg.entries()) {
    const anchor = orgMailboxes[0];
    let total = 0;
    let empty = 0;
    try {
      const result = await db.execute(sql`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE from_email = '' OR subject = '')::int AS empty
        FROM email_messages
        WHERE org_id = ${orgId}
          AND created_at >= ${windowStart}
      `);
      const row = (result.rows?.[0] ?? {}) as { total?: number; empty?: number };
      total = Number(row.total ?? 0);
      empty = Number(row.empty ?? 0);
    } catch (err) {
      log(`empty-content query failed org=${orgId}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const ratio = total > 0 ? empty / total : 0;
    const tripped =
      total >= EMPTY_CONTENT_MIN_VOLUME && ratio >= EMPTY_CONTENT_RATIO_THRESHOLD;

    if (tripped) {
      orgsTripped++;
      const next = (_emptyContentTickCount.get(orgId) ?? 0) + 1;
      _emptyContentTickCount.set(orgId, next);
      if (next >= QUOTE_PIPELINE_CONSECUTIVE_TICKS) {
        const pct = Math.round(ratio * 100);
        const reason =
          `Empty-content spike: ${pct}% of new email_messages rows in last ${EMPTY_CONTENT_WINDOW_MIN} min ` +
          `have empty from_email or subject (${empty}/${total}). ` +
          `Likely Graph payload missing fields or extraction regression — check mailboxDeltaSyncService.`;
        const result = await storage
          .fireMailboxHealthAlert({
            orgId,
            mailboxId: anchor.id,
            alertKey: ALERT_KEY_EMPTY_CONTENT_SPIKE,
            severity: "warning",
            reason,
          })
          .catch(() => null);
        if (result?.isNew) {
          alertsFired++;
          await fanOutAdminNotifications(
            anchor,
            "Email ingestion: empty-content spike",
            reason,
          ).catch(() => {});
        }
      }
    } else {
      _emptyContentTickCount.delete(orgId);
      const resolved = await storage
        .resolveMailboxHealthAlert(anchor.id, ALERT_KEY_EMPTY_CONTENT_SPIKE)
        .catch(() => null);
      if (resolved) alertsResolved++;
    }
  }

  return { orgsChecked: byOrg.size, orgsTripped, alertsFired, alertsResolved };
}

// Test-only: reset per-org streak trackers so unit tests can assert
// streak-gating behavior deterministically.
export function _resetIngestionWatchdogTrackersForTests(): void {
  _ingestSilentDropTickCount.clear();
  _emptyContentTickCount.clear();
}

export const _INGESTION_WATCHDOG_THRESHOLDS_FOR_TESTS = {
  ingestDropWindowMin: INGEST_DROP_WINDOW_MIN,
  ingestDropMinNotifications: INGEST_DROP_MIN_NOTIFICATIONS,
  emptyContentWindowMin: EMPTY_CONTENT_WINDOW_MIN,
  emptyContentMinVolume: EMPTY_CONTENT_MIN_VOLUME,
  emptyContentRatioThreshold: EMPTY_CONTENT_RATIO_THRESHOLD,
  consecutiveTicks: QUOTE_PIPELINE_CONSECUTIVE_TICKS,
  alertKeyIngestionSilentDrop: ALERT_KEY_INGESTION_SILENT_DROP,
  alertKeyEmptyContentSpike: ALERT_KEY_EMPTY_CONTENT_SPIKE,
};

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
    // Task #939 — classification-lag check. Runs once per watchdog tick,
    // independent of the per-mailbox subscription/webhook checks above
    // (the lag is an org-wide property of the inline classifier
    // dispatcher, not a per-mailbox condition).
    let lagSummary: Awaited<ReturnType<typeof runClassificationLagCheck>> | null = null;
    try {
      lagSummary = await runClassificationLagCheck(mailboxes, now);
    } catch (err) {
      log(`classification-lag check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Task #951 — live-sync health. Detects (a) prod SSE auth regression
    // and (b) silent-stream regressions. Independent of per-mailbox
    // checks; failure here is best-effort and never aborts the cycle.
    let liveSyncSummary: Awaited<ReturnType<typeof runLiveSyncHealthCheck>> | null = null;
    try {
      liveSyncSummary = await runLiveSyncHealthCheck(mailboxes, now);
    } catch (err) {
      log(`live-sync health check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Task #952 — quote-pipeline health. Catches "zero capture" (org
    // receiving customer email but ingesting no quotes) and "classifier
    // outage" (large fraction dropped). Best-effort.
    let quotePipelineSummary: Awaited<ReturnType<typeof runQuotePipelineHealthCheck>> | null = null;
    try {
      quotePipelineSummary = await runQuotePipelineHealthCheck(mailboxes, now);
    } catch (err) {
      log(`quote-pipeline health check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Post-incident guardrails — ingestion silent drop (Graph delivers but
    // nothing lands) and empty-content spike (rows land but with empty
    // required fields). Both auto-resolve once the underlying condition
    // lifts. Best-effort; never aborts the cycle.
    let ingestSilentDropSummary: Awaited<ReturnType<typeof runIngestionSilentDropCheck>> | null = null;
    try {
      ingestSilentDropSummary = await runIngestionSilentDropCheck(mailboxes, now);
    } catch (err) {
      log(`ingestion-silent-drop check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    let emptyContentSummary: Awaited<ReturnType<typeof runEmptyContentSpikeCheck>> | null = null;
    try {
      emptyContentSummary = await runEmptyContentSpikeCheck(mailboxes, now);
    } catch (err) {
      log(`empty-content-spike check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (trigger === "cron") {
      const lagSuffix = lagSummary
        ? `, lag: ${lagSummary.orgsLagging}/${lagSummary.orgsChecked} org(s) lagging, ${lagSummary.alertsFired} alert(s) fired, ${lagSummary.alertsResolved} resolved`
        : "";
      const lsSuffix = liveSyncSummary
        ? `, live-sync: ${liveSyncSummary.authStats.success}/${liveSyncSummary.authStats.total} ok, ` +
          `${liveSyncSummary.orgsSilent}/${liveSyncSummary.orgsChecked} silent, ` +
          `${liveSyncSummary.alertsFired} alert(s) fired, ${liveSyncSummary.alertsResolved} resolved`
        : "";
      const qpSuffix = quotePipelineSummary
        ? `, quote-pipeline: ${quotePipelineSummary.orgsZeroCapture} zero-capture, ` +
          `${quotePipelineSummary.orgsClassifierOutage} classifier-outage, ` +
          `${quotePipelineSummary.alertsFired} alert(s) fired, ${quotePipelineSummary.alertsResolved} resolved`
        : "";
      const ingestSuffix = ingestSilentDropSummary
        ? `, ingest-drop: ${ingestSilentDropSummary.orgsTripped}/${ingestSilentDropSummary.orgsChecked} tripped, ${ingestSilentDropSummary.alertsFired} alert(s) fired, ${ingestSilentDropSummary.alertsResolved} resolved`
        : "";
      const emptySuffix = emptyContentSummary
        ? `, empty-content: ${emptyContentSummary.orgsTripped}/${emptyContentSummary.orgsChecked} tripped, ${emptyContentSummary.alertsFired} alert(s) fired, ${emptyContentSummary.alertsResolved} resolved`
        : "";
      log(`Cycle done: ${mailboxes.length} mailbox(es), ${unhealthy} unhealthy, ${degraded} degraded, ${healed} self-healed${lagSuffix}${lsSuffix}${qpSuffix}${ingestSuffix}${emptySuffix}`);
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
