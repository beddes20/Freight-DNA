/**
 * Microsoft Graph Change Notification Subscription Service — Task #182
 *
 * Registers and renews a Graph change-notification subscription on the
 * OUTLOOK_REPLY_EMAIL mailbox so the platform receives webhooks when a
 * carrier replies to an outreach email.
 *
 * Prerequisites (all must be true before the service does anything):
 *   - OUTLOOK_TENANT_ID / OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET set
 *   - OUTLOOK_REPLY_EMAIL set (the shared mailbox to watch)
 *   - APP_BASE_URL set (public HTTPS URL the webhook endpoint is reachable at)
 *   - Mail.Read application permission granted by IT in Azure AD
 *
 * The service gracefully no-ops if any prerequisite is missing.  It logs a
 * single warning at startup so admins know what to configure.
 *
 * Subscriptions expire after ~3 days; this service renews them automatically
 * every 2 days via a setInterval background job.
 */

import { azureCredentialsConfigured, getGraphAccessToken } from "./graphService";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [graph-sub] ${msg}`);
}

export interface ReplyEmailConfig {
  mailbox: string;
  webhookUrl: string;
}

let _subscriptionId: string | null = null;
let _renewalTimer: ReturnType<typeof setInterval> | null = null;

// Set to true when Mail.Read is confirmed active; false means gracefully dormant
let _mailReadGranted = false;

export function replyTrackingEnabled(): boolean {
  return _mailReadGranted && !!_subscriptionId;
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
  if (hasAzureCreds && mailbox && baseUrl && !_mailReadGranted) {
    missingPermissions.push("Mail.Read (Azure AD application permission — contact IT)");
  }

  if (_mailReadGranted && !_subscriptionId) {
    warnings.push("Mail.Read granted but subscription is not active — check server logs");
  }

  if (!process.env.OUTLOOK_WEBHOOK_SECRET) {
    warnings.push("OUTLOOK_WEBHOOK_SECRET is not set — webhook validation uses an insecure default. Set this secret before deploying to production.");
  }

  return {
    enabled: _mailReadGranted && !!_subscriptionId,
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
 * Checks whether the Graph token includes Mail.Read by attempting a
 * lightweight call that requires it.  Returns true if OK, false otherwise.
 */
async function checkMailReadPermission(mailbox: string): Promise<boolean> {
  try {
    const token = await getGraphAccessToken();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/inbox?$select=id`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 200) return true;
    if (res.status === 403) {
      const body = await res.text();
      log(`Mail.Read permission not granted (403): ${body.slice(0, 200)}`);
      return false;
    }
    log(`Unexpected status ${res.status} checking Mail.Read permission`);
    return false;
  } catch (err) {
    log(`Error checking Mail.Read permission: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function findExistingSubscription(token: string, webhookUrl: string): Promise<{ id: string; expirationDateTime: string } | null> {
  try {
    const res = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json() as { value: Array<{ id: string; notificationUrl: string; expirationDateTime: string }> };
    return data.value?.find(s => s.notificationUrl === webhookUrl) ?? null;
  } catch {
    return null;
  }
}

async function registerSubscription(config: ReplyEmailConfig): Promise<string | null> {
  try {
    const token = await getGraphAccessToken();
    // Graph enforces a max of ~4230 minutes for Outlook message subscriptions.
    // We use 4200 minutes (~2d 22h) to stay safely under the limit.
    const SUB_TTL_MS = 4200 * 60 * 1000;

    // Reuse an existing subscription if one already matches our webhook URL.
    // This avoids creating duplicates when the server restarts before the old
    // subscription expires (Graph subscriptions survive server restarts).
    const existing = await findExistingSubscription(token, config.webhookUrl);
    if (existing) {
      const expiresAt = new Date(existing.expirationDateTime);
      const timeLeft = expiresAt.getTime() - Date.now();
      if (timeLeft > 24 * 60 * 60 * 1000) {
        // Plenty of time remaining — reuse as-is to avoid creating duplicates
        log(`Reusing existing subscription id=${existing.id} (expires=${existing.expirationDateTime})`);
        return existing.id;
      }
      // Less than 24h remaining — renew in place rather than creating a new subscription.
      // This avoids a brief window of duplicate subscriptions between old expiry and new creation.
      log(`Existing subscription id=${existing.id} expires soon — renewing in place`);
      const renewed = await renewSubscription(existing.id);
      if (renewed) return existing.id;
      // Renewal failed — fall through to register a fresh subscription
    }

    const expiresAt = new Date(Date.now() + SUB_TTL_MS).toISOString();

    const body = {
      changeType: "created",
      notificationUrl: config.webhookUrl,
      resource: `/users/${config.mailbox}/mailFolders/inbox/messages`,
      expirationDateTime: expiresAt,
      clientState: process.env.OUTLOOK_WEBHOOK_SECRET ?? "freight-dna-reply-tracker",
    };

    const res = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

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
    // Same 4200-minute TTL as registration — stays under Graph's ~4230 min cap
    const SUB_TTL_MS = 4200 * 60 * 1000;
    const expiresAt = new Date(Date.now() + SUB_TTL_MS).toISOString();

    const res = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expirationDateTime: expiresAt }),
    });

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

/**
 * Initialize the Graph subscription service.
 * Call once at app startup.  Safe to call even when unconfigured.
 */
let _activationTimer: ReturnType<typeof setInterval> | null = null;

async function tryActivate(config: { mailbox: string; webhookUrl: string }): Promise<boolean> {
  if (_subscriptionId) return true; // already active

  const hasPermission = await checkMailReadPermission(config.mailbox);
  if (!hasPermission) return false;

  _mailReadGranted = true;
  log(`Mail.Read confirmed. Registering webhook subscription → ${config.webhookUrl}`);

  const subId = await registerSubscription(config);
  if (!subId) {
    log("Could not register subscription — will retry next cycle");
    return false;
  }

  _subscriptionId = subId;

  // Renew every 2 days (subscription expires after 3)
  const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
  _renewalTimer = setInterval(async () => {
    if (!_subscriptionId) return;
    const renewed = await renewSubscription(_subscriptionId);
    if (!renewed) {
      log("Renewal failed — attempting to re-register subscription");
      _subscriptionId = await registerSubscription(config);
    }
  }, TWO_DAYS_MS);

  // Stop the activation poller — we're live
  if (_activationTimer) {
    clearInterval(_activationTimer);
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
  if (!config) {
    log("OUTLOOK_REPLY_EMAIL or APP_BASE_URL not set — reply tracking disabled");
    return;
  }

  log(`Checking Mail.Read permission for mailbox: ${config.mailbox}`);
  const activated = await tryActivate(config);

  if (!activated) {
    log("Mail.Read not yet granted — reply tracking dormant. Will retry every hour until granted.");
    // Poll hourly so that activation happens automatically when IT grants the permission,
    // without needing a server restart.
    const ONE_HOUR_MS = 60 * 60 * 1000;
    _activationTimer = setInterval(() => tryActivate(config), ONE_HOUR_MS);
  }
}

export function stopGraphSubscriptionService(): void {
  if (_renewalTimer) {
    clearInterval(_renewalTimer);
    _renewalTimer = null;
  }
  if (_activationTimer) {
    clearInterval(_activationTimer);
    _activationTimer = null;
  }
}
