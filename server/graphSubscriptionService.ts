/**
 * Microsoft Graph Change Notification Subscription Service — Task #182 / #230
 *
 * Registers and renews Graph change-notification subscriptions on:
 *   1. The shared OUTLOOK_REPLY_EMAIL mailbox (carrier reply tracking)
 *   2. Individual NAM/AM mailboxes from the monitored_mailboxes table (customer email sync)
 *
 * Prerequisites (all must be true before the service does anything):
 *   - OUTLOOK_TENANT_ID / OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET set
 *   - APP_BASE_URL set (public HTTPS URL the webhook endpoint is reachable at)
 *   - Mail.Read application permission granted by IT in Azure AD
 */

import cron from "node-cron";
import { azureCredentialsConfigured, getGraphAccessToken } from "./graphService";
import { storage, db } from "./storage";
import { sql } from "drizzle-orm";
import { resilientFetch } from "./lib/httpRetry";
import { JOB_NAMES, withHeartbeat } from "./lib/cronHeartbeat";
import type { MonitoredMailbox } from "@shared/schema";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [graph-sub] ${msg}`);
}

export interface ReplyEmailConfig {
  mailbox: string;
  webhookUrl: string;
}

let _subscriptionId: string | null = null;
// Cron-anchored renewer for the shared OUTLOOK_REPLY_EMAIL subscription.
// Was previously setInterval(48h) which reset on every workflow restart and
// could miss the 70h Graph TTL during back-to-back deploys. Now matches the
// per-rep mailbox renewer cadence (every 6h, clock-anchored).
let _renewalTimer: ReturnType<typeof cron.schedule> | null = null;

let _mailReadGranted = false;

// Task #517 — persisted Mail.Read tenant consent state. The Azure
// app-only credentials are global to one tenant, so a single in-memory
// snapshot covers every org served by this process. Surfaced via the
// admin API so the Email Intelligence + Customer Quoting coverage banners
// can tell admins exactly why ingestion is dormant.
type MailReadConsent = "granted" | "pending" | "denied" | "unknown";
let _mailReadConsent: MailReadConsent = "unknown";
let _mailReadLastCheckedAt: Date | null = null;
let _mailReadLastError: string | null = null;
let _mailReadLoadedFromDb = false;

const CONSENT_SCOPE = "tenant";

/**
 * Lazy-load the persisted Mail.Read consent state on first access. We
 * keep the in-memory snapshot as a write-through cache so reads are
 * cheap; the DB is the durable source of truth across server restarts.
 */
interface PersistedConsentRow {
  status: string;
  last_checked_at: Date | string | null;
  last_error: string | null;
  mailbox: string | null;
}

/**
 * Type guard for the persisted-consent row shape. Used to safely narrow
 * the unknown rows pulled from raw SQL without resorting to `any`.
 */
function isPersistedConsentRow(value: unknown): value is PersistedConsentRow {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.status === "string"
    && (v.last_checked_at === null || v.last_checked_at instanceof Date || typeof v.last_checked_at === "string")
    && (v.last_error === null || typeof v.last_error === "string")
    && (v.mailbox === null || typeof v.mailbox === "string");
}

function isValidConsentStatus(s: string): s is MailReadConsent {
  return s === "granted" || s === "pending" || s === "denied" || s === "unknown";
}

async function loadConsentFromDbIfNeeded(): Promise<void> {
  if (_mailReadLoadedFromDb) return;
  try {
    const result = await db.execute(sql`
      SELECT status, last_checked_at, last_error, mailbox
      FROM graph_tenant_consent WHERE scope = ${CONSENT_SCOPE} LIMIT 1
    `);
    // node-postgres drizzle.execute returns { rows: T[] }; some adapters
    // return the array directly. Handle both shapes through unknown.
    const raw: unknown = result;
    let firstRow: unknown = undefined;
    if (raw && typeof raw === "object" && "rows" in raw) {
      const rows = (raw as { rows: unknown }).rows;
      if (Array.isArray(rows)) firstRow = rows[0];
    } else if (Array.isArray(raw)) {
      firstRow = raw[0];
    }
    if (isPersistedConsentRow(firstRow)) {
      if (isValidConsentStatus(firstRow.status)) {
        _mailReadConsent = firstRow.status;
        if (firstRow.status === "granted") _mailReadGranted = true;
      }
      _mailReadLastCheckedAt = firstRow.last_checked_at
        ? new Date(firstRow.last_checked_at)
        : null;
      _mailReadLastError = firstRow.last_error;
    }
  } catch (err) {
    log(`Failed to load persisted Mail.Read consent: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    _mailReadLoadedFromDb = true;
  }
}

/**
 * Persist current Mail.Read consent snapshot. Best-effort: a DB write
 * failure should never break the live activation flow, so we log + move on.
 */
async function persistConsent(mailbox: string | null): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO graph_tenant_consent (scope, status, last_checked_at, last_error, mailbox, updated_at)
      VALUES (${CONSENT_SCOPE}, ${_mailReadConsent}, ${_mailReadLastCheckedAt}, ${_mailReadLastError}, ${mailbox}, NOW())
      ON CONFLICT (scope) DO UPDATE
        SET status = EXCLUDED.status,
            last_checked_at = EXCLUDED.last_checked_at,
            last_error = EXCLUDED.last_error,
            mailbox = EXCLUDED.mailbox,
            updated_at = NOW()
    `);
  } catch (err) {
    log(`Failed to persist Mail.Read consent: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface MailReadConsentStatus {
  status: MailReadConsent;
  lastCheckedAt: string | null;
  lastError: string | null;
  configured: boolean;
  mailbox: string | null;
}

/**
 * Synchronous read of the in-memory consent snapshot. Triggers a
 * non-blocking DB hydrate on first call so the live process eventually
 * reflects what was persisted by a previous run, but doesn't await it
 * (callers that need DB-fresh state should await getMailReadConsentStatusAsync).
 */
export function getMailReadConsentStatus(): MailReadConsentStatus {
  if (!_mailReadLoadedFromDb) {
    void loadConsentFromDbIfNeeded();
  }
  return {
    status: _mailReadConsent,
    lastCheckedAt: _mailReadLastCheckedAt ? _mailReadLastCheckedAt.toISOString() : null,
    lastError: _mailReadLastError,
    configured: azureCredentialsConfigured(),
    mailbox: process.env.OUTLOOK_REPLY_EMAIL?.trim() ?? null,
  };
}

/** DB-fresh variant used by the coverage endpoint on first request. */
export async function getMailReadConsentStatusAsync(): Promise<MailReadConsentStatus> {
  await loadConsentFromDbIfNeeded();
  return getMailReadConsentStatus();
}

/**
 * Run an on-demand Mail.Read tenant consent probe. Returns the latest
 * status snapshot. Used by the admin coverage endpoint so a refresh
 * shows the current truth instead of stale init-time state.
 */
export async function refreshMailReadConsentStatus(): Promise<MailReadConsentStatus> {
  await loadConsentFromDbIfNeeded();
  if (!azureCredentialsConfigured()) {
    _mailReadConsent = "unknown";
    _mailReadLastError = "Azure credentials not configured";
    _mailReadLastCheckedAt = new Date();
    await persistConsent(null);
    return getMailReadConsentStatus();
  }
  // Probe targets: try the configured shared reply mailbox first, then any
  // enabled monitored mailbox. Tenant admins frequently set
  // OUTLOOK_REPLY_EMAIL to a generic alias that doesn't exist as a real
  // user mailbox in M365 — that returns 404 ErrorInvalidUser, NOT 403.
  // We must distinguish "probe target doesn't exist" from "permission
  // denied" or admins see a misleading "Mail.Read not granted" banner
  // even when IT has correctly granted the permission.
  const candidates: string[] = [];
  const replyEmail = process.env.OUTLOOK_REPLY_EMAIL?.trim();
  if (replyEmail) candidates.push(replyEmail);
  try {
    const enabled = await storage.getEnabledMonitoredMailboxes();
    for (const m of enabled) {
      if (m.email && !candidates.includes(m.email)) candidates.push(m.email);
      if (candidates.length >= 5) break; // bound the probe cost
    }
  } catch {
    // ignore — fall through with whatever we have
  }
  if (candidates.length === 0) {
    _mailReadConsent = "pending";
    _mailReadLastError = "No mailbox to probe — enroll a mailbox first";
    _mailReadLastCheckedAt = new Date();
    await persistConsent(null);
    return getMailReadConsentStatus();
  }

  let lastResult: { status: number | null; mailbox: string } = { status: null, mailbox: candidates[0] };
  let granted = false;
  let permissionDenied = false;
  for (const mailbox of candidates) {
    try {
      const result = await probeMailReadPermission(mailbox);
      lastResult = { status: result.status, mailbox };
      if (result.status === 200) { granted = true; break; }
      if (result.status === 403) { permissionDenied = true; break; }
      // 404 / 400 / others → try the next candidate
    } catch (err) {
      lastResult = { status: null, mailbox };
      _mailReadLastError = err instanceof Error ? err.message : String(err);
    }
  }

  if (granted) {
    _mailReadConsent = "granted";
    _mailReadLastError = null;
    _mailReadGranted = true;
  } else if (permissionDenied) {
    _mailReadConsent = "denied";
    _mailReadLastError = "Mail.Read application permission not granted in tenant";
  } else {
    // Every candidate returned a non-200, non-403 status (typically 404
    // ErrorInvalidUser when OUTLOOK_REPLY_EMAIL points at a non-existent
    // mailbox and no real mailboxes are enrolled yet). Don't claim
    // permission is denied — say what's actually true so admins know
    // to enroll a real mailbox or fix OUTLOOK_REPLY_EMAIL.
    _mailReadConsent = "pending";
    _mailReadLastError = lastResult.status === 404
      ? `Probe mailbox "${lastResult.mailbox}" was not found in your Microsoft 365 tenant. Enroll a real user mailbox or set OUTLOOK_REPLY_EMAIL to a mailbox that exists.`
      : `Could not verify Mail.Read permission against any candidate mailbox (last status: ${lastResult.status ?? "error"}).`;
  }
  _mailReadLastCheckedAt = new Date();
  await persistConsent(lastResult.mailbox);
  return getMailReadConsentStatus();
}

export function replyTrackingEnabled(): boolean {
  return _mailReadGranted && !!_subscriptionId;
}

/**
 * Task #549 — Production-readiness gate for the Graph webhook clientState
 * secret. We refuse to register subscriptions or accept webhook payloads
 * unless this value is configured. There is no insecure default fallback:
 * an unauthenticated webhook would let anyone inject fake mailbox events.
 */
export function getWebhookClientState(): string | null {
  const v = process.env.OUTLOOK_WEBHOOK_SECRET?.trim();
  return v && v.length > 0 ? v : null;
}

export function webhookSecretConfigured(): boolean {
  return getWebhookClientState() !== null;
}

export interface ReplyTrackingStatus {
  enabled: boolean;
  mailbox: string | null;
  subscriptionActive: boolean;
  missingPermissions: string[];
  warnings: string[];
}

export function getReplyTrackingStatus(): ReplyTrackingStatus {
  const mailbox = process.env.OUTLOOK_REPLY_EMAIL?.trim() ?? null;
  const baseUrl = process.env.APP_BASE_URL?.trim() ?? null;
  const hasAzureCreds = !!(process.env.OUTLOOK_TENANT_ID && process.env.OUTLOOK_CLIENT_ID && process.env.OUTLOOK_CLIENT_SECRET);

  const missingPermissions: string[] = [];
  const warnings: string[] = [];

  if (!hasAzureCreds) missingPermissions.push("OUTLOOK_TENANT_ID / OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET");
  if (!mailbox) missingPermissions.push("OUTLOOK_REPLY_EMAIL");
  if (!baseUrl) missingPermissions.push("APP_BASE_URL");
  // Task #549 — webhook secret is now a hard requirement. Without it the
  // outlook-reply and graph/email handlers refuse to process notifications,
  // and registerSubscription refuses to register, so reply tracking will
  // not work at all.
  if (!webhookSecretConfigured()) {
    missingPermissions.push("OUTLOOK_WEBHOOK_SECRET");
  }
  if (hasAzureCreds && mailbox && baseUrl && !_mailReadGranted) {
    missingPermissions.push("Mail.Read (Azure AD application permission — contact IT)");
  }

  if (_mailReadGranted && !_subscriptionId) {
    warnings.push("Mail.Read granted but subscription is not active — check server logs");
  }

  return {
    enabled: _mailReadGranted && !!_subscriptionId && webhookSecretConfigured(),
    mailbox,
    subscriptionActive: !!_subscriptionId,
    missingPermissions,
    warnings,
  };
}

export function getReplyEmailConfig(): ReplyEmailConfig | null {
  const mailbox = process.env.OUTLOOK_REPLY_EMAIL?.trim();
  const baseUrl = process.env.APP_BASE_URL?.trim();
  if (!mailbox || !baseUrl) return null;
  return {
    mailbox,
    webhookUrl: `${baseUrl.replace(/\/$/, "")}/api/webhooks/outlook-reply`,
  };
}

/**
 * Low-level Mail.Read probe. Returns the raw HTTP status so callers can
 * distinguish "permission denied" (403) from "mailbox does not exist in
 * tenant" (404 ErrorInvalidUser). Returns `null` on network/transport
 * errors. The boolean wrapper `checkMailReadPermission` is preserved
 * for callers that only need a yes/no.
 */
async function probeMailReadPermission(mailbox: string): Promise<{ status: number | null; bodyPreview: string }> {
  try {
    const token = await getGraphAccessToken();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/inbox?$select=id`;
    const res = await resilientFetch("graph", () => fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    }));
    let bodyPreview = "";
    if (res.status !== 200) {
      try { bodyPreview = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    }
    if (res.status === 403) log(`Mail.Read permission denied for ${mailbox} (403): ${bodyPreview}`);
    else if (res.status === 404) log(`Probe mailbox ${mailbox} not found in tenant (404 ErrorInvalidUser)`);
    else if (res.status !== 200) log(`Unexpected status ${res.status} probing ${mailbox}: ${bodyPreview}`);
    return { status: res.status, bodyPreview };
  } catch (err) {
    log(`Error probing Mail.Read for ${mailbox}: ${err instanceof Error ? err.message : String(err)}`);
    return { status: null, bodyPreview: err instanceof Error ? err.message : String(err) };
  }
}

async function checkMailReadPermission(mailbox: string): Promise<boolean> {
  const result = await probeMailReadPermission(mailbox);
  return result.status === 200;
}

async function findExistingSubscription(token: string, webhookUrl: string): Promise<{ id: string; expirationDateTime: string } | null> {
  try {
    const res = await resilientFetch("graph", () => fetch("https://graph.microsoft.com/v1.0/subscriptions", {
      headers: { Authorization: `Bearer ${token}` },
    }));
    if (!res.ok) return null;
    const data = await res.json() as { value: Array<{ id: string; notificationUrl: string; expirationDateTime: string }> };
    return data.value?.find(s => s.notificationUrl === webhookUrl) ?? null;
  } catch {
    return null;
  }
}

async function registerSubscription(config: ReplyEmailConfig): Promise<string | null> {
  // Task #549 — refuse to register without an explicit webhook secret. A
  // subscription with an empty/predictable clientState would let any caller
  // POST forged notifications to /api/webhooks/outlook-reply.
  const clientState = getWebhookClientState();
  if (!clientState) {
    log("Refusing to register reply subscription — OUTLOOK_WEBHOOK_SECRET is not set. Configure the secret and restart the server.");
    return null;
  }

  try {
    const token = await getGraphAccessToken();
    const SUB_TTL_MS = 4200 * 60 * 1000;

    const existing = await findExistingSubscription(token, config.webhookUrl);
    if (existing) {
      const expiresAt = new Date(existing.expirationDateTime);
      const timeLeft = expiresAt.getTime() - Date.now();
      if (timeLeft > 24 * 60 * 60 * 1000) {
        log(`Reusing existing subscription id=${existing.id} (expires=${existing.expirationDateTime})`);
        return existing.id;
      }
      log(`Existing subscription id=${existing.id} expires soon — renewing in place`);
      const renewed = await renewSubscription(existing.id);
      if (renewed) return existing.id;
    }

    const expiresAt = new Date(Date.now() + SUB_TTL_MS).toISOString();

    const body = {
      changeType: "created",
      notificationUrl: config.webhookUrl,
      resource: `/users/${config.mailbox}/mailFolders/inbox/messages`,
      expirationDateTime: expiresAt,
      clientState,
    };

    const res = await resilientFetch("graph", () => fetch("https://graph.microsoft.com/v1.0/subscriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }));

    if (res.status === 201) {
      const data = await res.json() as { id: string; expirationDateTime: string };
      log(`Subscription registered (id=${data.id}, expires=${data.expirationDateTime})`);
      return data.id;
    }

    const errorText = await res.text();
    log(`Failed to register subscription (${res.status}): ${errorText.slice(0, 400)}`);
    return null;
  } catch (err) {
    log(`Exception registering subscription: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function renewSubscription(subscriptionId: string): Promise<boolean> {
  try {
    const token = await getGraphAccessToken();
    const SUB_TTL_MS = 4200 * 60 * 1000;
    const expiresAt = new Date(Date.now() + SUB_TTL_MS).toISOString();

    const res = await resilientFetch("graph", () => fetch(`https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expirationDateTime: expiresAt }),
    }));

    if (res.status === 200) {
      log(`Subscription ${subscriptionId} renewed until ${expiresAt}`);
      return true;
    }

    const errorText = await res.text();
    log(`Failed to renew subscription ${subscriptionId} (${res.status}): ${errorText.slice(0, 200)}`);
    return false;
  } catch (err) {
    log(`Exception renewing subscription: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// Cron-anchored activation retry. Was previously setInterval(1h) — same
// restart-resets-the-clock vulnerability as the renewer.
let _activationTimer: ReturnType<typeof cron.schedule> | null = null;

async function tryActivate(config: { mailbox: string; webhookUrl: string }): Promise<boolean> {
  if (_subscriptionId) return true;

  // Mirror refreshMailReadConsentStatus: distinguish 404 (probe mailbox
  // doesn't exist in tenant) from 403 (permission denied). Without this,
  // a misconfigured OUTLOOK_REPLY_EMAIL on a tenant where IT has correctly
  // granted Mail.Read would have its consent state reverted to "denied"
  // here on every activation cycle, overwriting the correct status that
  // refreshMailReadConsentStatus computes from real enrolled mailboxes.
  const probe = await probeMailReadPermission(config.mailbox);
  _mailReadLastCheckedAt = new Date();
  if (probe.status !== 200) {
    if (probe.status === 403) {
      _mailReadConsent = "denied";
      _mailReadLastError = "Mail.Read application permission not granted in tenant";
    } else if (probe.status === 404) {
      // The configured shared reply mailbox doesn't exist — leave any
      // existing "granted" state intact, just record a pending note so
      // admins can see the misconfiguration.
      if (_mailReadConsent !== "granted") {
        _mailReadConsent = "pending";
        _mailReadLastError = `Reply mailbox "${config.mailbox}" was not found in your Microsoft 365 tenant. Set OUTLOOK_REPLY_EMAIL to a real mailbox or remove it.`;
      }
    } else if (_mailReadConsent !== "granted") {
      _mailReadConsent = "unknown";
      _mailReadLastError = `Could not verify Mail.Read against ${config.mailbox} (status ${probe.status ?? "error"}).`;
    }
    void persistConsent(config.mailbox);
    return false;
  }

  _mailReadGranted = true;
  _mailReadConsent = "granted";
  _mailReadLastError = null;
  void persistConsent(config.mailbox);
  log(`Mail.Read confirmed. Registering webhook subscription → ${config.webhookUrl}`);

  const subId = await registerSubscription(config);
  if (!subId) {
    log("Could not register subscription — will retry next cycle");
    return false;
  }

  _subscriptionId = subId;

  // Cron-anchored: every 6 hours at minute 13 (offset from the user-mailbox
  // renewer at minute 7 to avoid lockstep API hits). Heartbeated so a
  // silently-failing renewer is detectable within ~9 minutes (graceFactor 1.5).
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  if (_renewalTimer) _renewalTimer.stop();
  _renewalTimer = cron.schedule("13 */6 * * *", () => {
    void withHeartbeat(JOB_NAMES.graphSharedMailboxRenewal, SIX_HOURS_MS, async () => {
      if (!_subscriptionId) return;
      const renewed = await renewSubscription(_subscriptionId);
      if (!renewed) {
        log("Renewal failed — attempting to re-register subscription");
        _subscriptionId = await registerSubscription(config);
      }
    });
  });

  if (_activationTimer) {
    _activationTimer.stop();
    _activationTimer = null;
  }

  log("Reply tracking active");
  return true;
}

export async function initGraphSubscriptionService(): Promise<void> {
  if (!azureCredentialsConfigured()) {
    log("Azure credentials not configured — reply tracking disabled");
    return;
  }

  const config = getReplyEmailConfig();
  if (config) {
    log(`Checking Mail.Read permission for mailbox: ${config.mailbox}`);
    const activated = await tryActivate(config);

    if (!activated) {
      log("Mail.Read not yet granted — reply tracking dormant. Will retry every hour until granted.");
      const ONE_HOUR_MS = 60 * 60 * 1000;
      // Cron at minute 19 each hour. Heartbeated so an admin can see whether
      // the retry loop is actually firing.
      _activationTimer = cron.schedule("19 * * * *", () => {
        void withHeartbeat(JOB_NAMES.graphSharedMailboxActivationRetry, ONE_HOUR_MS, () => tryActivate(config));
      });
    }
  } else {
    log("OUTLOOK_REPLY_EMAIL or APP_BASE_URL not set — shared mailbox reply tracking disabled");
  }

  await initUserMailboxSubscriptions();
}

export function stopGraphSubscriptionService(): void {
  if (_renewalTimer) {
    _renewalTimer.stop();
    _renewalTimer = null;
  }
  if (_activationTimer) {
    _activationTimer.stop();
    _activationTimer = null;
  }
  if (_userMailboxRenewalCron) {
    _userMailboxRenewalCron.stop();
    _userMailboxRenewalCron = null;
  }
}

let _userMailboxRenewalCron: ReturnType<typeof cron.schedule> | null = null;

export async function registerMailboxSubscription(mailboxEmail: string, mailboxId: string): Promise<string | null> {
  if (!azureCredentialsConfigured()) return null;
  const baseUrl = process.env.APP_BASE_URL?.trim();
  if (!baseUrl) return null;

  // Task #549 — refuse to register a per-rep webhook unless the clientState
  // secret is set. Surface the reason on the mailbox row so admins see it
  // immediately on the Monitored Mailboxes page.
  const clientState = getWebhookClientState();
  if (!clientState) {
    log(`[user-mailbox] Refusing to register subscription for ${mailboxEmail} — OUTLOOK_WEBHOOK_SECRET is not set.`);
    await storage.updateMonitoredMailbox(mailboxId, {
      syncStatus: "error",
      syncError: "OUTLOOK_WEBHOOK_SECRET is not configured. Set the secret in IT settings and try again.",
    });
    return null;
  }

  const webhookUrl = `${baseUrl.replace(/\/$/, "")}/api/webhooks/graph/email`;

  try {
    const token = await getGraphAccessToken();
    const SUB_TTL_MS = 4200 * 60 * 1000;
    const expiresAt = new Date(Date.now() + SUB_TTL_MS).toISOString();

    const inboxResource = `/users/${mailboxEmail}/mailFolders/inbox/messages`;
    const sentResource = `/users/${mailboxEmail}/mailFolders/sentitems/messages`;

    let inboxSubId: string | null = null;
    let sentSubId: string | null = null;
    const failures: string[] = [];

    for (const [resource, label] of [[inboxResource, "inbox"], [sentResource, "sentitems"]] as const) {
      const body = {
        changeType: "created",
        notificationUrl: webhookUrl,
        resource,
        expirationDateTime: expiresAt,
        clientState,
      };

      const res = await resilientFetch("graph", () => fetch("https://graph.microsoft.com/v1.0/subscriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }));

      if (res.status === 201) {
        const data = await res.json() as { id: string; expirationDateTime: string };
        log(`[user-mailbox] Subscription registered for ${mailboxEmail} ${label} (id=${data.id})`);
        if (label === "inbox") inboxSubId = data.id;
        else sentSubId = data.id;
      } else {
        const errorText = await res.text();
        log(`[user-mailbox] Failed to register ${label} subscription for ${mailboxEmail} (${res.status}): ${errorText.slice(0, 400)}`);

        let friendly = `${label}: HTTP ${res.status}`;
        if (res.status === 404) {
          friendly = `Mailbox "${mailboxEmail}" was not found in your Microsoft 365 tenant. Verify the email address is exact and the user has an Outlook mailbox.`;
        } else if (res.status === 403) {
          friendly = `Permission denied. The "Mail.Read" application permission has not been granted in Azure AD for this tenant. Contact IT to grant admin consent.`;
        } else if (res.status === 400 && errorText.includes("notificationUrl")) {
          friendly = `Microsoft rejected the webhook URL. Make sure APP_BASE_URL is a public HTTPS URL reachable from the internet.`;
        } else {
          try {
            const parsed = JSON.parse(errorText);
            const apiMsg = parsed?.error?.message ?? errorText.slice(0, 200);
            friendly = `${label}: ${apiMsg}`;
          } catch {
            friendly = `${label}: ${errorText.slice(0, 200)}`;
          }
        }
        failures.push(friendly);
      }
    }

    if (inboxSubId || sentSubId) {
      await storage.updateMonitoredMailbox(mailboxId, {
        subscriptionId: inboxSubId,
        sentItemsSubscriptionId: sentSubId,
        subscriptionExpiresAt: new Date(expiresAt),
        syncStatus: "active",
        syncError: null,
      });
      return inboxSubId ?? sentSubId;
    }

    const errorMsg = failures.length > 0
      ? failures.join(" | ").slice(0, 500)
      : "Failed to register Graph subscriptions";

    await storage.updateMonitoredMailbox(mailboxId, {
      syncStatus: "error",
      syncError: errorMsg,
    });
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[user-mailbox] Exception registering subscription for ${mailboxEmail}: ${msg}`);
    await storage.updateMonitoredMailbox(mailboxId, {
      syncStatus: "error",
      syncError: msg.slice(0, 200),
    });
    return null;
  }
}

export async function removeMailboxSubscription(subscriptionId: string, mailboxId: string): Promise<void> {
  if (!azureCredentialsConfigured()) return;

  const mailbox = await storage.getMonitoredMailbox(mailboxId);
  const subIds = [subscriptionId];
  if (mailbox?.sentItemsSubscriptionId && mailbox.sentItemsSubscriptionId !== subscriptionId) {
    subIds.push(mailbox.sentItemsSubscriptionId);
  }

  try {
    const token = await getGraphAccessToken();
    for (const sid of subIds) {
      const res = await resilientFetch("graph", () => fetch(`https://graph.microsoft.com/v1.0/subscriptions/${sid}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }));
      if (res.ok || res.status === 404) {
        log(`[user-mailbox] Subscription ${sid} removed`);
      } else {
        log(`[user-mailbox] Failed to remove subscription ${sid}: ${res.status}`);
      }
    }
  } catch (err) {
    log(`[user-mailbox] Exception removing subscriptions: ${err instanceof Error ? err.message : String(err)}`);
  }

  await storage.updateMonitoredMailbox(mailboxId, {
    subscriptionId: null,
    sentItemsSubscriptionId: null,
    subscriptionExpiresAt: null,
    syncStatus: "disabled",
  });
}

// In-process mutex so the periodic cron, the boot pass, and a manual
// admin trigger never overlap and double-register the same subscription.
// Concurrent renewals can produce phantom Graph subscription IDs that
// then look orphaned on Microsoft's side.
let _renewalInFlight = false;
async function withRenewalLock<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  if (_renewalInFlight) {
    log(`[user-mailbox] ${label} skipped — another renewal pass is in flight`);
    return fallback;
  }
  _renewalInFlight = true;
  try {
    return await fn();
  } finally {
    _renewalInFlight = false;
  }
}

/**
 * Renew (or re-register) every enabled monitored mailbox's Graph
 * subscriptions. Safe to call repeatedly — idempotent per-mailbox.
 *
 * If `orgId` is provided, only that org's mailboxes are touched. The
 * periodic cron and boot pass call this without an orgId (system-wide);
 * the admin endpoint always passes the caller's org unless an admin
 * explicitly requests `allOrgs`.
 *
 * Returns a small summary that admin endpoints surface back to the UI so
 * a "Renew now" click can show what happened.
 */
export type MailboxRenewOutcome = "renewed" | "reregistered" | "failed";

export interface MailboxRenewResult {
  mailboxId: string;
  email: string;
  outcome: MailboxRenewOutcome;
  /** When the outcome is "failed", the human-friendly reason mirrored from
   * the mailbox row's syncError. Null on success. */
  syncError: string | null;
  /** Auto-backfill summary when the renewal succeeded. Null when skipped
   * (e.g. failed renewals or backfill itself errored beyond recovery). */
  backfill: {
    delta: { processed: number; errors: number };
    selfHeal: { scanned: number; threadsRecovered: number; errors: number };
  } | null;
}

type RenewSummary = {
  attempted: number;
  renewed: number;
  reregistered: number;
  failed: number;
  skipped?: boolean;
  /** Per-mailbox outcome — Task #794. The capture-audit pill uses this to
   * name which mailbox(es) failed in the toast, and to rank failing
   * mailboxes to the top of the popover. */
  results: MailboxRenewResult[];
};

/**
 * After we successfully renew (or re-register) a mailbox's Graph
 * subscriptions, the mailbox may have missed messages while the webhook
 * was down. This kicks off a delta-sync poll for that mailbox and a
 * mailbox-scoped self-heal pass for any waiting_on_us threads — so the
 * "Renew subscriptions" button in the capture-audit pill isn't followed by
 * "now please also click Sync now and Run capture audit now" (Task #794).
 */
async function backfillAfterRenew(mailbox: MonitoredMailbox): Promise<MailboxRenewResult["backfill"]> {
  const result: NonNullable<MailboxRenewResult["backfill"]> = {
    delta: { processed: 0, errors: 0 },
    selfHeal: { scanned: 0, threadsRecovered: 0, errors: 0 },
  };
  try {
    const { syncMailboxDelta } = await import("./services/mailboxDeltaSyncService");
    const r = await syncMailboxDelta(mailbox.id);
    result.delta = { processed: r.processed, errors: r.errors };
  } catch (err) {
    log(`[user-mailbox] backfill delta error for ${mailbox.email}: ${err instanceof Error ? err.message : String(err)}`);
    result.delta.errors++;
  }
  try {
    const { selfHealStuckThreads } = await import("./services/conversationReplyCaptureService");
    // recentAuditDedupeMs: 0 — the user just clicked "Renew now" and is
    // expecting a fresh attempt. minStuckMs: 0 so even very recent waits
    // get a recovery pass. Cap to 25 threads so a misconfigured mailbox
    // can't burn Graph quota in a single click.
    const sweep = await selfHealStuckThreads({
      orgId: mailbox.orgId,
      mailboxIds: [mailbox.id],
      triggeredBy: "manual",
      minStuckMs: 0,
      perMailboxLimit: 25,
      maxThreads: 50,
      recentAuditDedupeMs: 0,
    });
    result.selfHeal = { scanned: sweep.scanned, threadsRecovered: sweep.threadsRecovered, errors: sweep.errors };
  } catch (err) {
    log(`[user-mailbox] backfill self-heal error for ${mailbox.email}: ${err instanceof Error ? err.message : String(err)}`);
    result.selfHeal.errors++;
  }
  return result;
}

async function renewOneMailbox(mb: MonitoredMailbox): Promise<MailboxRenewResult> {
  // Either subscription missing → re-register both. The previous `&&`
  // skipped re-registration when one was missing, which left the
  // capture-audit pill stuck red because missing SentItems alone is
  // counted as an unhealthy mailbox.
  if (!mb.subscriptionId || !mb.sentItemsSubscriptionId) {
    const id = await registerMailboxSubscription(mb.email, mb.id);
    if (id) {
      const fresh = (await storage.getMonitoredMailbox(mb.id)) ?? mb;
      const backfill = await backfillAfterRenew(fresh);
      return { mailboxId: mb.id, email: mb.email, outcome: "reregistered", syncError: null, backfill };
    }
    const fresh = await storage.getMonitoredMailbox(mb.id);
    return { mailboxId: mb.id, email: mb.email, outcome: "failed", syncError: fresh?.syncError ?? "Re-registration failed", backfill: null };
  }

  let allRenewed = true;
  for (const sid of [mb.subscriptionId, mb.sentItemsSubscriptionId]) {
    if (sid) {
      const renewed = await renewSubscription(sid);
      if (!renewed) allRenewed = false;
    }
  }

  if (allRenewed) {
    const SUB_TTL_MS = 4200 * 60 * 1000;
    await storage.updateMonitoredMailbox(mb.id, {
      subscriptionExpiresAt: new Date(Date.now() + SUB_TTL_MS),
      syncStatus: "active",
      syncError: null,
    });
    const fresh = (await storage.getMonitoredMailbox(mb.id)) ?? mb;
    const backfill = await backfillAfterRenew(fresh);
    return { mailboxId: mb.id, email: mb.email, outcome: "renewed", syncError: null, backfill };
  }

  log(`[user-mailbox] Renewal failed for ${mb.email} — re-registering`);
  const id = await registerMailboxSubscription(mb.email, mb.id);
  if (id) {
    const fresh = (await storage.getMonitoredMailbox(mb.id)) ?? mb;
    const backfill = await backfillAfterRenew(fresh);
    return { mailboxId: mb.id, email: mb.email, outcome: "reregistered", syncError: null, backfill };
  }
  const fresh = await storage.getMonitoredMailbox(mb.id);
  return { mailboxId: mb.id, email: mb.email, outcome: "failed", syncError: fresh?.syncError ?? "Renewal failed", backfill: null };
}

export async function renewUserMailboxSubscriptions(orgId?: string): Promise<RenewSummary> {
  const summary: RenewSummary = { attempted: 0, renewed: 0, reregistered: 0, failed: 0, results: [] };
  if (!azureCredentialsConfigured()) return summary;

  return withRenewalLock(
    "renewUserMailboxSubscriptions",
    async () => {
      try {
        const mailboxes = await storage.getEnabledMonitoredMailboxes(orgId);
        for (const mb of mailboxes) {
          summary.attempted++;
          const result = await renewOneMailbox(mb);
          summary.results.push(result);
          if (result.outcome === "renewed") summary.renewed++;
          else if (result.outcome === "reregistered") summary.reregistered++;
          else summary.failed++;
        }
      } catch (err) {
        log(`[user-mailbox] Error renewing subscriptions: ${err instanceof Error ? err.message : String(err)}`);
      }
      return summary;
    },
    { attempted: 0, renewed: 0, reregistered: 0, failed: 0, results: [], skipped: true as const },
  );
}

/**
 * Single-mailbox retry path used by the capture-audit pill's "Retry this
 * mailbox" button (Task #794). Reuses the same renewOneMailbox helper as
 * the org-wide pass so the auto-backfill behavior is identical. Returns
 * `null` when the mailbox isn't found or doesn't belong to the caller's
 * org (the route enforces org scoping).
 */
export type SingleMailboxRetryResult =
  | (MailboxRenewResult & { skipped?: undefined })
  | { skipped: true; reason: string };

export async function renewSingleMailboxSubscription(mailboxId: string): Promise<SingleMailboxRetryResult> {
  if (!azureCredentialsConfigured()) {
    return { skipped: true, reason: "Azure credentials not configured" };
  }
  const mailbox = await storage.getMonitoredMailbox(mailboxId);
  if (!mailbox) {
    return { skipped: true, reason: "Mailbox not found" };
  }
  if (!mailbox.enabled) {
    return { skipped: true, reason: "Mailbox is disabled — enable it before retrying" };
  }
  return withRenewalLock<SingleMailboxRetryResult>(
    `renewSingleMailboxSubscription:${mailboxId}`,
    async () => renewOneMailbox(mailbox),
    { skipped: true, reason: "Another renewal pass is in flight — try again in a few seconds" },
  );
}

/**
 * Boot-time pass: re-register expired subs AND proactively renew anything
 * expiring within the next 24h. The previous boot only touched
 * already-expired rows, which left a window where a fresh deploy a few
 * hours before TTL would silently roll into expiry before the periodic
 * renewer's first tick. With this we also pre-renew the imminent ones.
 *
 * Like the renewer, accepts an optional `orgId` to scope the pass.
 */
type ExpiringPassResult = {
  expired: number;
  expiringSoon: number;
  skipped?: boolean;
};

export async function renewExpiringSoonSubscriptions(
  thresholdMs: number = 24 * 60 * 60 * 1000,
  orgId?: string,
): Promise<ExpiringPassResult> {
  const result: ExpiringPassResult = { expired: 0, expiringSoon: 0 };
  if (!azureCredentialsConfigured()) return result;

  return withRenewalLock(
    "renewExpiringSoonSubscriptions",
    async () => {
      const mailboxes = await storage.getEnabledMonitoredMailboxes(orgId);
      const now = Date.now();
      for (const mb of mailboxes) {
        const exp = mb.subscriptionExpiresAt?.getTime() ?? 0;
        const noSub = !mb.subscriptionId || !mb.sentItemsSubscriptionId;
        const isExpired = !!mb.subscriptionExpiresAt && exp < now;
        const isExpiringSoon = !!mb.subscriptionExpiresAt && exp >= now && exp - now < thresholdMs;

        if (noSub || isExpired) {
          await registerMailboxSubscription(mb.email, mb.id);
          result.expired++;
          continue;
        }

        if (isExpiringSoon) {
          let allRenewed = true;
          for (const sid of [mb.subscriptionId, mb.sentItemsSubscriptionId]) {
            if (sid) {
              const renewed = await renewSubscription(sid);
              if (!renewed) allRenewed = false;
            }
          }
          if (allRenewed) {
            const SUB_TTL_MS = 4200 * 60 * 1000;
            await storage.updateMonitoredMailbox(mb.id, {
              subscriptionExpiresAt: new Date(Date.now() + SUB_TTL_MS),
              syncStatus: "active",
            });
            result.expiringSoon++;
          } else {
            log(`[user-mailbox] Pre-renewal failed for ${mb.email} — re-registering`);
            await registerMailboxSubscription(mb.email, mb.id);
            result.expiringSoon++;
          }
        }
      }
      return result;
    },
    { expired: 0, expiringSoon: 0, skipped: true as const },
  );
}

async function initUserMailboxSubscriptions(): Promise<void> {
  if (!azureCredentialsConfigured()) return;

  try {
    const mailboxes = await storage.getEnabledMonitoredMailboxes();
    if (mailboxes.length === 0) {
      log("[user-mailbox] No monitored mailboxes configured");
      return;
    }

    log(`[user-mailbox] Initializing subscriptions for ${mailboxes.length} monitored mailbox(es)`);

    // Boot pass: cover both expired AND about-to-expire-within-24h subs
    // so a deploy near the end of TTL doesn't leak into red-pill territory
    // before the periodic renewer's next tick.
    const bootStats = await renewExpiringSoonSubscriptions();
    if (bootStats.expired > 0 || bootStats.expiringSoon > 0) {
      log(`[user-mailbox] Boot pass: re-registered=${bootStats.expired}, pre-renewed=${bootStats.expiringSoon}`);
    }

    // Periodic renewal: cron-anchored so workflow restarts no longer reset
    // the renewal clock. Every 6h is generous against the 70h TTL — even
    // if a renewal cycle fails, the next two attempts arrive well before
    // expiry.
    if (_userMailboxRenewalCron) {
      _userMailboxRenewalCron.stop();
      _userMailboxRenewalCron = null;
    }
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    _userMailboxRenewalCron = cron.schedule("7 */6 * * *", () => {
      void withHeartbeat(JOB_NAMES.graphUserMailboxRenewal, SIX_HOURS_MS, renewUserMailboxSubscriptions);
    });
    log("[user-mailbox] Renewal scheduler registered (every 6h via node-cron)");
  } catch (err) {
    log(`[user-mailbox] Init error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
