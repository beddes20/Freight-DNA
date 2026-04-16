/**
 * Webex Re-Authorization Notifications
 *
 * Fires once when the stored Webex refresh token transitions into the
 * "needs re-authorization" state. Sends an in-app notification to every
 * admin user across every organization, plus an email when their username
 * looks like an email address and email delivery is enabled.
 *
 * Also exposes a follow-up reminder helper that can be invoked on a
 * recurring schedule. While Webex remains in the needs-reauth state we
 * re-notify admins at most once every 24 hours so the alert isn't lost
 * after the initial transition. Reminder bookkeeping (and the
 * needs-reauth flag itself) is persisted to the `api_response_cache`
 * table so the reminder cadence survives process restarts and deploys.
 */

import { storage, db } from "./storage";
import { users } from "../shared/schema";
import { eq } from "drizzle-orm";
import { sendEmail, emailEnabled, baseEmailTemplate } from "./emailService";
import {
  webexNeedsReauth,
  getWebexAuthState,
  markWebexNeedsReauth,
  hasWebexTokens,
} from "./webexService";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${t} [webex-reauth] ${msg}`);
}

const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STATE_CACHE_KEY = "webex_reauth_state";

interface PersistedState {
  needsReauth: boolean;
  alertAt: number | null;
  reminderAt: number | null;
  reason: string | null;
}

let lastAlertAt: number | null = null;
let lastReminderAt: number | null = null;
let lastReason: string | null = null;
let stateLoaded = false;

async function loadPersistedState(): Promise<PersistedState | null> {
  try {
    const result = await storage.pool.query(
      `SELECT response_data FROM api_response_cache WHERE cache_key = $1 LIMIT 1`,
      [STATE_CACHE_KEY],
    );
    const row = result.rows?.[0];
    if (!row?.response_data) return null;
    const data = row.response_data as Partial<PersistedState>;
    return {
      needsReauth: !!data.needsReauth,
      alertAt: typeof data.alertAt === "number" ? data.alertAt : null,
      reminderAt: typeof data.reminderAt === "number" ? data.reminderAt : null,
      reason: typeof data.reason === "string" ? data.reason : null,
    };
  } catch (e) {
    log(`Failed to load persisted reauth state: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function savePersistedState(): Promise<void> {
  const payload: PersistedState = {
    needsReauth: webexNeedsReauth(),
    alertAt: lastAlertAt,
    reminderAt: lastReminderAt,
    reason: lastReason,
  };
  try {
    await storage.pool.query(
      `INSERT INTO api_response_cache (cache_key, response_data, cached_at, ttl_seconds)
       VALUES ($1, $2::jsonb, NOW(), 31536000)
       ON CONFLICT (cache_key) DO UPDATE SET response_data = $2::jsonb, cached_at = NOW()`,
      [STATE_CACHE_KEY, JSON.stringify(payload)],
    );
  } catch (e) {
    log(`Failed to persist reauth state: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function deletePersistedState(): Promise<void> {
  try {
    await storage.pool.query(
      `DELETE FROM api_response_cache WHERE cache_key = $1`,
      [STATE_CACHE_KEY],
    );
  } catch (e) {
    log(`Failed to delete persisted reauth state: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function ensureStateLoaded(): Promise<void> {
  if (stateLoaded) return;
  stateLoaded = true;
  const persisted = await loadPersistedState();
  if (!persisted) return;

  lastAlertAt = persisted.alertAt;
  lastReminderAt = persisted.reminderAt;
  lastReason = persisted.reason;

  // If Webex was in the needs-reauth state when the previous process exited,
  // restore that flag in-memory so the reminder cron can keep firing — but
  // only if the boot path didn't manage to load a valid refresh token.
  if (persisted.needsReauth && !hasWebexTokens() && !webexNeedsReauth()) {
    markWebexNeedsReauth(persisted.reason ?? "restored from previous session");
    log("Restored needs-reauth flag from persisted state");
  }
}

/**
 * Public accessor so other modules (route registration) can prime the
 * persisted needs-reauth flag at boot. Safe to call multiple times — the
 * load is memoized.
 */
export async function initWebexReauthState(): Promise<void> {
  await ensureStateLoaded();
}

function buildEmailHtml(
  adminName: string,
  appUrl: string,
  reason: string,
  isReminder: boolean,
): string {
  const link = `${appUrl.replace(/\/$/, "")}/admin/users`;
  const safeReason = reason.replace(/[<>]/g, c => (c === "<" ? "&lt;" : "&gt;")).slice(0, 300);
  const heading = isReminder
    ? "Reminder: Webex still needs to be reconnected"
    : "Webex needs to be reconnected";
  const intro = isReminder
    ? `<p>Hi ${adminName || "Admin"},</p>
       <p>This is a follow-up reminder — Freight DNA's connection to
       <strong>Webex Calling</strong> is still disconnected. Until an admin
       re-authorizes Webex, call history sync, missed-call alerts, and
       presence will remain paused. We'll keep nudging you about once a day
       until it's reconnected.</p>`
    : `<p>Hi ${adminName || "Admin"},</p>
       <p>Freight DNA's connection to <strong>Webex Calling</strong> has stopped working
       because the stored authorization was revoked or expired. Until an admin
       re-authorizes Webex, call history sync, missed-call alerts, and presence
       will be paused.</p>`;
  const body = `
    ${intro}
    <div class="item">
      <div class="item-title">What to do</div>
      <div class="item-meta">Open the admin settings, find the Webex Calling Integration card,
      and click <strong>Re-authorize Webex</strong>. The whole flow takes about a minute.</div>
    </div>
    <p><a class="cta" href="${link}">Re-authorize Webex</a></p>
    <p style="font-size:12px;color:#6b7280;margin-top:24px">Reason reported by Webex: <code>${safeReason}</code></p>
  `;
  return baseEmailTemplate(heading, body);
}

async function sendReauthAlertToAdmins(
  reason: string,
  isReminder: boolean,
): Promise<void> {
  const adminUsers = await db
    .select()
    .from(users)
    .where(eq(users.role, "admin"));

  if (adminUsers.length === 0) {
    log("No admin users found to notify");
    return;
  }

  const appUrl = process.env.APP_URL?.trim() || "";
  let inAppCount = 0;
  let emailCount = 0;

  const notificationType = isReminder
    ? "webex_needs_reauth_reminder"
    : "webex_needs_reauth";
  const notificationTitle = isReminder
    ? "Reminder: Webex still needs to be reconnected"
    : "Webex needs to be reconnected";
  const notificationBody = isReminder
    ? "Follow-up: call sync is still paused. Re-authorize Webex from the admin settings to resume."
    : "Call sync is paused until an admin re-authorizes Webex from the admin settings.";
  const subject = isReminder
    ? "[Freight DNA] Reminder: Webex still needs to be reconnected"
    : "[Freight DNA] Webex needs to be reconnected";

  for (const admin of adminUsers) {
    try {
      const already = await storage.hasUnreadNotification(
        admin.id,
        notificationType,
        "webex",
      );
      if (!already) {
        await storage.createNotification({
          userId: admin.id,
          type: notificationType,
          title: notificationTitle,
          body: notificationBody,
          link: "/admin/users",
          relatedId: "webex",
          read: false,
        });
        inAppCount++;
      }
    } catch (notifErr) {
      log(
        `Failed in-app notify for admin ${admin.id}: ${
          notifErr instanceof Error ? notifErr.message : String(notifErr)
        }`,
      );
    }

    if (emailEnabled() && admin.username?.includes("@")) {
      try {
        const ok = await sendEmail({
          to: admin.username,
          subject,
          html: buildEmailHtml(
            admin.name || admin.username,
            appUrl,
            reason,
            isReminder,
          ),
        });
        if (ok) emailCount++;
      } catch (mailErr) {
        log(
          `Failed email to admin ${admin.username}: ${
            mailErr instanceof Error ? mailErr.message : String(mailErr)
          }`,
        );
      }
    }
  }

  log(
    `Sent Webex re-auth ${isReminder ? "reminder" : "alert"} to ${adminUsers.length} admins (${inAppCount} new in-app, ${emailCount} emails)`,
  );
}

export async function notifyAdminsOfWebexReauthNeeded(reason: string): Promise<void> {
  try {
    await ensureStateLoaded();
    await sendReauthAlertToAdmins(reason, false);
    lastAlertAt = Date.now();
    lastReminderAt = null;
    lastReason = reason;
    await savePersistedState();
  } catch (err) {
    log(`notifyAdminsOfWebexReauthNeeded error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Fires a follow-up reminder if Webex is still in the needs-reauth state and
 * at least 24 hours have passed since the last alert/reminder. Safe to call
 * on a frequent schedule (e.g. hourly); it self-throttles.
 */
export async function maybeSendWebexReauthReminder(): Promise<void> {
  try {
    await ensureStateLoaded();
    if (!webexNeedsReauth()) return;

    const now = Date.now();
    const lastFiredAt = lastReminderAt ?? lastAlertAt;

    if (lastFiredAt == null) {
      // We're in needs-reauth but have no record of the initial alert.
      // Start the clock now and persist so the next reminder fires roughly
      // one interval from here, even across restarts.
      lastAlertAt = now;
      await savePersistedState();
      return;
    }

    if (now - lastFiredAt < REMINDER_INTERVAL_MS) return;

    const reason =
      lastReason
      ?? getWebexAuthState().lastRefreshError
      ?? "previously reported authorization failure";
    await sendReauthAlertToAdmins(reason, true);
    lastReminderAt = now;
    lastReason = reason;
    await savePersistedState();
  } catch (err) {
    log(`maybeSendWebexReauthReminder error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Clears the reminder bookkeeping (in-memory and persisted). Call this once
 * Webex has been successfully re-authorized so any future disconnect starts
 * fresh and reminders stop immediately.
 */
export async function resetWebexReauthReminderState(): Promise<void> {
  lastAlertAt = null;
  lastReminderAt = null;
  lastReason = null;
  stateLoaded = true;
  await deletePersistedState();
}
