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

import { azureCredentialsConfigured, getGraphAccessToken } from "./graphService";
import { storage } from "./storage";

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

let _activationTimer: ReturnType<typeof setInterval> | null = null;

async function tryActivate(config: { mailbox: string; webhookUrl: string }): Promise<boolean> {
  if (_subscriptionId) return true;

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

  const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
  _renewalTimer = setInterval(async () => {
    if (!_subscriptionId) return;
    const renewed = await renewSubscription(_subscriptionId);
    if (!renewed) {
      log("Renewal failed — attempting to re-register subscription");
      _subscriptionId = await registerSubscription(config);
    }
  }, TWO_DAYS_MS);

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
  if (config) {
    log(`Checking Mail.Read permission for mailbox: ${config.mailbox}`);
    const activated = await tryActivate(config);

    if (!activated) {
      log("Mail.Read not yet granted — reply tracking dormant. Will retry every hour until granted.");
      const ONE_HOUR_MS = 60 * 60 * 1000;
      _activationTimer = setInterval(() => tryActivate(config), ONE_HOUR_MS);
    }
  } else {
    log("OUTLOOK_REPLY_EMAIL or APP_BASE_URL not set — shared mailbox reply tracking disabled");
  }

  await initUserMailboxSubscriptions();
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
  if (_userMailboxRenewalTimer) {
    clearInterval(_userMailboxRenewalTimer);
    _userMailboxRenewalTimer = null;
  }
}

let _userMailboxRenewalTimer: ReturnType<typeof setInterval> | null = null;

export async function registerMailboxSubscription(mailboxEmail: string, mailboxId: string): Promise<string | null> {
  if (!azureCredentialsConfigured()) return null;
  const baseUrl = process.env.APP_BASE_URL?.trim();
  if (!baseUrl) return null;

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
      const res = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${sid}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
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

async function renewUserMailboxSubscriptions(): Promise<void> {
  if (!azureCredentialsConfigured()) return;

  try {
    const mailboxes = await storage.getEnabledMonitoredMailboxes();
    for (const mb of mailboxes) {
      if (!mb.subscriptionId && !mb.sentItemsSubscriptionId) {
        await registerMailboxSubscription(mb.email, mb.id);
        continue;
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
        });
      } else {
        log(`[user-mailbox] Renewal failed for ${mb.email} — re-registering`);
        await registerMailboxSubscription(mb.email, mb.id);
      }
    }
  } catch (err) {
    log(`[user-mailbox] Error renewing subscriptions: ${err instanceof Error ? err.message : String(err)}`);
  }
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

    for (const mb of mailboxes) {
      if (mb.subscriptionId) {
        const expired = mb.subscriptionExpiresAt && mb.subscriptionExpiresAt.getTime() < Date.now();
        if (!expired) {
          log(`[user-mailbox] ${mb.email}: existing subscription still valid`);
          continue;
        }
      }
      await registerMailboxSubscription(mb.email, mb.id);
    }

    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    _userMailboxRenewalTimer = setInterval(renewUserMailboxSubscriptions, TWO_DAYS_MS);
  } catch (err) {
    log(`[user-mailbox] Init error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
