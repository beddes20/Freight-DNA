/**
 * Webex real-time webhook service (Task #741).
 *
 * Replaces blind 5-min / 30-min polling for telephony_calls and voicemails
 * with push notifications from Webex. The poller stays as a fallback and
 * is throttled adaptively when webhooks are healthy (see `webhooksHealthy`
 * + `kickOffOrgBackfill` in the scheduler).
 *
 * High-level flow:
 *
 *   1. On OAuth complete (org or per-user), `subscribeWebhooksForOrg` /
 *      `subscribeWebhooksForUser` POSTs `/v1/webhooks` for each
 *      (resource, event) pair we care about. Each subscription gets a
 *      32-byte random `secret` so we can verify HMAC-SHA1 of the raw
 *      payload on every notification.
 *
 *   2. Webex POSTs `/api/webhooks/webex` (registered BEFORE express.json()
 *      in server/index.ts so we get the raw body). The receiver:
 *        a) parses payload.id (the webhook id) → looks up our row
 *        b) verifies `X-Spark-Signature` HMAC-SHA1 with the row's secret
 *        c) inserts into `webex_webhook_events` (event_id unique → dedupe)
 *        d) responds 200 immediately, dispatches async
 *
 *   3. Dispatcher routes telephony_calls events into the existing
 *      enrichment job queue (CDR + recording + Whisper + summary) and
 *      voicemails events into voicemail ingestion. Errors are recorded
 *      on the event row but never block ack.
 *
 *   4. On disconnect (`revokeWebhooksForOrg` / `revokeWebhooksForUser`),
 *      we DELETE each Webex-side webhook and remove our rows.
 */

import crypto from "crypto";
import type { Request } from "express";
import { storage } from "./storage";
import {
  webexFetch,
  getWebexAccessToken,
  hasWebexTokens,
  webexNeedsReauth,
  fetchVoicemailAudio,
} from "./webexService";
import { getUserWebexAccessToken } from "./webexUserTokenService";
import { enqueueEnrichmentJob } from "./webexEnrichmentWorker";
import type {
  InsertWebexWebhookSubscription,
  WebexWebhookSubscription,
} from "@shared/schema";

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Resources + events we subscribe to. Webex supports event="all" which
 * covers created/updated/deleted in one webhook — we use that to keep
 * the subscription count low (Webex limits ~100 webhooks per app).
 */
export const WEBEX_WEBHOOK_TARGETS: ReadonlyArray<{ resource: string; event: string }> = [
  { resource: "telephony_calls", event: "all" },
  { resource: "voicemails", event: "all" },
];

const WEBHOOK_PATH = "/api/webhooks/webex";
const WEBEX_API_WEBHOOKS = "https://webexapis.com/v1/webhooks";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [webex-webhooks] ${msg}`);
}

// ─── Target URL ─────────────────────────────────────────────────────────────

/**
 * Resolve the public URL Webex should POST to. Prefers WEBEX_WEBHOOK_URL,
 * then APP_URL, then derives from the request host. Always ends with
 * the receiver path.
 */
export function resolveWebhookTargetUrl(req?: Request): string {
  const envExplicit = process.env.WEBEX_WEBHOOK_URL?.trim();
  if (envExplicit) return envExplicit;
  const appUrl = process.env.APP_URL?.trim();
  if (appUrl) return `${appUrl.replace(/\/$/, "")}${WEBHOOK_PATH}`;
  if (req) {
    const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
    const host = req.get("host");
    if (host) return `${proto}://${host}${WEBHOOK_PATH}`;
  }
  // Last-resort fallback — not viable for real Webex delivery, but keeps
  // tests happy.
  return `http://localhost:5000${WEBHOOK_PATH}`;
}

// ─── Signature verification ─────────────────────────────────────────────────

/**
 * Verify Webex's `X-Spark-Signature` HMAC-SHA1(raw body, secret).
 * Uses constant-time comparison to avoid timing leaks.
 */
export function verifyWebexSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  try {
    const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
    const expected = crypto.createHmac("sha1", secret).update(buf).digest("hex");
    const sig = signatureHeader.trim().toLowerCase();
    if (sig.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

// ─── Webex CRUD helpers ─────────────────────────────────────────────────────

interface WebexWebhookRecord {
  id: string;
  name: string;
  resource: string;
  event: string;
  targetUrl: string;
  status?: string;
  created?: string;
  ownedBy?: string;
}

async function createWebexSideWebhook(args: {
  token: string;
  name: string;
  targetUrl: string;
  resource: string;
  event: string;
  secret: string;
}): Promise<WebexWebhookRecord> {
  const res = await webexFetch<WebexWebhookRecord>(WEBEX_API_WEBHOOKS, {
    method: "POST",
    token: args.token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: args.name,
      targetUrl: args.targetUrl,
      resource: args.resource,
      event: args.event,
      secret: args.secret,
    }),
  });
  if (!res.ok || !res.data?.id) {
    throw new Error(`webex create webhook failed: HTTP ${res.status} ${res.error ?? ""}`);
  }
  return res.data;
}

async function deleteWebexSideWebhook(token: string, webhookId: string): Promise<void> {
  const res = await webexFetch(`${WEBEX_API_WEBHOOKS}/${encodeURIComponent(webhookId)}`, {
    method: "DELETE",
    token,
  });
  // 404 is fine — webhook already gone on Webex's side.
  if (!res.ok && res.status !== 404) {
    throw new Error(`webex delete webhook failed: HTTP ${res.status} ${res.error ?? ""}`);
  }
}

async function listWebexSideWebhooks(token: string): Promise<WebexWebhookRecord[]> {
  const res = await webexFetch<{ items?: WebexWebhookRecord[] }>(`${WEBEX_API_WEBHOOKS}?max=100`, { token });
  if (!res.ok) return [];
  return res.data?.items ?? [];
}

// ─── Subscribe / Revoke ─────────────────────────────────────────────────────

interface SubscribeOpts {
  /** Override the receiver URL (otherwise resolved from env/req). */
  targetUrl?: string;
  req?: Request;
}

interface SubscribeResult {
  resource: string;
  event: string;
  status: "active" | "error" | "skipped";
  webhookId?: string | null;
  error?: string;
}

async function ensureSubscription(
  args: {
    orgId: string;
    userId: string | null;
    scope: "org" | "user";
    token: string;
    targetUrl: string;
    resource: string;
    event: string;
    /**
     * When true, skip the "already-active" short-circuit and force a
     * fresh Webex create. Used by `refreshExpiringWebhooks` when the
     * row says active but the Webex-side webhook has been purged —
     * without this flag the row would never recover.
     */
    forceRecreate?: boolean;
  },
): Promise<SubscribeResult> {
  const existing = await storage.findWebexWebhookSubscription({
    orgId: args.orgId,
    userId: args.userId,
    resource: args.resource,
    event: args.event,
  });

  // Reuse the secret if we already have one — avoids invalidating
  // in-flight Webex retries that were signed with the old secret.
  const secret = existing?.secret ?? crypto.randomBytes(24).toString("hex");
  const name = `freightdna-${args.scope}-${args.resource}-${args.event}`.slice(0, 64);

  // If we already have a Webex webhook id and trust it, short-circuit.
  // Bypassed when `forceRecreate` is set (refresh path discovered the
  // Webex-side hook is gone) or when the targetUrl drifted.
  if (
    !args.forceRecreate &&
    existing?.webhookId &&
    existing.targetUrl === args.targetUrl &&
    existing.status === "active"
  ) {
    return { resource: args.resource, event: args.event, status: "active", webhookId: existing.webhookId };
  }

  // If we have a stale row (different targetUrl, OR caller asked to
  // force-recreate because Webex no longer knows the webhook id), best-
  // effort delete the old Webex-side row so we don't leak. For
  // forceRecreate we tolerate a 404 — the whole point is the hook is
  // already gone.
  if (existing?.webhookId && (args.forceRecreate || existing.targetUrl !== args.targetUrl)) {
    try { await deleteWebexSideWebhook(args.token, existing.webhookId); } catch (e) {
      log(`Failed to delete stale webhook ${existing.webhookId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    const created = await createWebexSideWebhook({
      token: args.token,
      name,
      targetUrl: args.targetUrl,
      resource: args.resource,
      event: args.event,
      secret,
    });
    const insert: InsertWebexWebhookSubscription = {
      orgId: args.orgId,
      userId: args.userId,
      scope: args.scope,
      resource: args.resource,
      event: args.event,
      webhookId: created.id,
      targetUrl: args.targetUrl,
      secret,
      status: "active",
      lastError: null,
      lastErrorAt: null,
    };
    await storage.upsertWebexWebhookSubscription(insert);
    log(`Subscribed ${args.scope} ${args.resource}/${args.event} → ${created.id} for org ${args.orgId}`);
    return { resource: args.resource, event: args.event, status: "active", webhookId: created.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Persist the failure so the health panel surfaces it.
    const insert: InsertWebexWebhookSubscription = {
      orgId: args.orgId,
      userId: args.userId,
      scope: args.scope,
      resource: args.resource,
      event: args.event,
      webhookId: existing?.webhookId ?? null,
      targetUrl: args.targetUrl,
      secret,
      status: "error",
      lastError: msg.slice(0, 500),
      lastErrorAt: new Date(),
    };
    await storage.upsertWebexWebhookSubscription(insert);
    log(`Subscribe failed ${args.scope} ${args.resource}/${args.event} for org ${args.orgId}: ${msg}`);
    return { resource: args.resource, event: args.event, status: "error", error: msg };
  }
}

/**
 * Subscribe org-wide telephony_calls + voicemails webhooks using the
 * org-level (admin) Webex token. Idempotent — re-runs reuse existing
 * rows / secrets.
 */
export async function subscribeWebhooksForOrg(orgId: string, opts: SubscribeOpts = {}): Promise<SubscribeResult[]> {
  if (!hasWebexTokens() || webexNeedsReauth()) {
    log(`subscribeWebhooksForOrg(${orgId}): skipped — no usable org token`);
    return WEBEX_WEBHOOK_TARGETS.map(t => ({ ...t, status: "skipped" as const }));
  }

  // Tenant-isolation guard. The org-level Webex token is a single shared
  // credential for the whole app. If another internal org already owns an
  // active org-level webhook bound to that credential, fan-out would (a)
  // create duplicate Webex webhooks and (b) deliver the same call event to
  // multiple internal orgs once the dispatch path matched by sub.orgId. We
  // therefore enforce a global singleton: org-level subs may exist for at
  // most ONE internal org. The first org to subscribe (typically the org
  // whose admin completed the OAuth flow) wins; subsequent orgs are
  // skipped at the service layer.
  const allOrgs = await storage.getOrganizations();
  for (const o of allOrgs) {
    if (o.id === orgId) continue;
    const otherSubs = await storage.listWebexWebhookSubscriptions(o.id);
    const hasActiveOrgSub = otherSubs.some(s => s.scope === "org" && s.status === "active");
    if (hasActiveOrgSub) {
      log(
        `subscribeWebhooksForOrg(${orgId}): skipped — org-level singleton already owned by ${o.id} ` +
          `(global Webex token is single-tenant)`,
      );
      return WEBEX_WEBHOOK_TARGETS.map(t => ({ ...t, status: "skipped" as const }));
    }
  }

  const targetUrl = opts.targetUrl ?? resolveWebhookTargetUrl(opts.req);
  let token: string;
  try {
    token = await getWebexAccessToken();
  } catch (err) {
    log(`subscribeWebhooksForOrg(${orgId}): token error ${err instanceof Error ? err.message : String(err)}`);
    return WEBEX_WEBHOOK_TARGETS.map(t => ({ ...t, status: "skipped" as const }));
  }
  const results: SubscribeResult[] = [];
  for (const t of WEBEX_WEBHOOK_TARGETS) {
    const r = await ensureSubscription({
      orgId,
      userId: null,
      scope: "org",
      token,
      targetUrl,
      resource: t.resource,
      event: t.event,
    });
    results.push(r);
  }
  return results;
}

/**
 * Subscribe per-user telephony_calls + voicemails webhooks using a
 * specific rep's Webex token. Used at per-user OAuth completion so
 * personal voicemail events flow even without admin credentials.
 */
export async function subscribeWebhooksForUser(
  orgId: string,
  userId: string,
  opts: SubscribeOpts = {},
): Promise<SubscribeResult[]> {
  const tokenInfo = await getUserWebexAccessToken(userId);
  if (!tokenInfo) {
    log(`subscribeWebhooksForUser(${userId}): no usable user token`);
    return WEBEX_WEBHOOK_TARGETS.map(t => ({ ...t, status: "skipped" as const }));
  }
  const targetUrl = opts.targetUrl ?? resolveWebhookTargetUrl(opts.req);
  const results: SubscribeResult[] = [];
  for (const t of WEBEX_WEBHOOK_TARGETS) {
    const r = await ensureSubscription({
      orgId,
      userId,
      scope: "user",
      token: tokenInfo.token,
      targetUrl,
      resource: t.resource,
      event: t.event,
    });
    results.push(r);
  }
  return results;
}

/** Revoke + remove all org-scoped webhook rows for an org. */
export async function revokeWebhooksForOrg(orgId: string): Promise<number> {
  const subs = (await storage.listWebexWebhookSubscriptions(orgId)).filter(s => s.scope === "org");
  if (subs.length === 0) return 0;
  let token: string | null = null;
  try { if (hasWebexTokens() && !webexNeedsReauth()) token = await getWebexAccessToken(); } catch { /* token unavailable */ }
  let removed = 0;
  for (const s of subs) {
    if (s.webhookId && token) {
      try { await deleteWebexSideWebhook(token, s.webhookId); } catch (e) {
        log(`revoke org ${orgId} webhook ${s.webhookId} delete error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await storage.deleteWebexWebhookSubscription(s.id);
    removed++;
  }
  log(`Revoked ${removed} org webhooks for ${orgId}`);
  return removed;
}

/**
 * Revoke + remove a single webhook subscription row by id. Used by the
 * admin "Delete" button so the operation matches its contract — the
 * bulk `revokeWebhooksFor{Org,User}` helpers are reserved for OAuth
 * disconnect flows where wiping every sub for that scope is intended.
 * (Task #741 defect #12.)
 */
export async function revokeSingleWebhookSubscription(subId: string): Promise<boolean> {
  const sub = await storage.getWebexWebhookSubscription(subId);
  if (!sub) return false;

  // Resolve a token usable to delete this specific Webex-side webhook.
  let token: string | null = null;
  if (sub.scope === "user" && sub.userId) {
    const t = await getUserWebexAccessToken(sub.userId);
    token = t?.token ?? null;
  } else if (hasWebexTokens() && !webexNeedsReauth()) {
    try { token = await getWebexAccessToken(); } catch { token = null; }
  }
  if (sub.webhookId && token) {
    try { await deleteWebexSideWebhook(token, sub.webhookId); } catch (e) {
      log(`revoke single webhook ${sub.webhookId} delete error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await storage.deleteWebexWebhookSubscription(sub.id);
  log(`Revoked single webhook sub=${sub.id} scope=${sub.scope} resource=${sub.resource}/${sub.event}`);
  return true;
}

/** Revoke + remove all per-user webhook rows for a single user. */
export async function revokeWebhooksForUser(userId: string): Promise<number> {
  const tokenInfo = await getUserWebexAccessToken(userId);
  // We need at least the token *or* the rows. Look up rows via storage.
  // listWebexWebhookSubscriptions is org-scoped, so first find the org.
  const userToken = await storage.getWebexUserToken(userId);
  if (!userToken) return 0;
  const subs = (await storage.listWebexWebhookSubscriptions(userToken.orgId))
    .filter(s => s.scope === "user" && s.userId === userId);
  if (subs.length === 0) return 0;
  let removed = 0;
  for (const s of subs) {
    if (s.webhookId && tokenInfo) {
      try { await deleteWebexSideWebhook(tokenInfo.token, s.webhookId); } catch (e) {
        log(`revoke user ${userId} webhook ${s.webhookId} delete error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await storage.deleteWebexWebhookSubscription(s.id);
    removed++;
  }
  log(`Revoked ${removed} user webhooks for ${userId}`);
  return removed;
}

/**
 * Periodic refresh — re-subscribes any rows in `error` status, and verifies
 * that the Webex-side webhook still exists for `active` rows. Safe to run
 * on a cron (called from the scheduler every ~15 minutes).
 */
export async function refreshExpiringWebhooks(
  scopeToOrgId?: string,
): Promise<{ checked: number; recreated: number; errors: number }> {
  let checked = 0, recreated = 0, errors = 0;
  let orgIds: string[];
  if (scopeToOrgId) {
    // Caller asked to limit reconciliation to a single tenant — used by the
    // admin "Refresh" button so an admin in org A can never trigger
    // lifecycle mutations against orgs B..N (Task #741 defect #11).
    const subs = await storage.listWebexWebhookSubscriptions(scopeToOrgId);
    orgIds = subs.length > 0 ? [scopeToOrgId] : [];
  } else {
    const allOrgs = await storage.getOrganizations();
    orgIds = [];
    for (const org of allOrgs) {
      const subs = await storage.listWebexWebhookSubscriptions(org.id);
      if (subs.length > 0) orgIds.push(org.id);
    }
  }

  for (const orgId of orgIds) {
    const subs = await storage.listWebexWebhookSubscriptions(orgId);
    let webexList: WebexWebhookRecord[] = [];
    let orgToken: string | null = null;
    try {
      if (hasWebexTokens() && !webexNeedsReauth()) {
        orgToken = await getWebexAccessToken();
        webexList = await listWebexSideWebhooks(orgToken);
      }
    } catch (e) {
      log(`refresh list-webhooks error org=${orgId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const livingIds = new Set(webexList.map(w => w.id));

    for (const s of subs) {
      checked++;
      const missing = !s.webhookId || !livingIds.has(s.webhookId);
      const broken = s.status === "error";
      if (!missing && !broken) continue;

      // Resolve the right token for this scope.
      let token: string | null = null;
      let userTokenInfo: { token: string } | null = null;
      if (s.scope === "org") {
        token = orgToken;
      } else if (s.userId) {
        userTokenInfo = await getUserWebexAccessToken(s.userId);
        token = userTokenInfo?.token ?? null;
      }
      if (!token) {
        // Can't recreate without a token — leave the row alone but log.
        log(`refresh: no token available for sub=${s.id} scope=${s.scope} user=${s.userId ?? "—"}`);
        continue;
      }

      const targetUrl = s.targetUrl ?? resolveWebhookTargetUrl();
      const previousWebhookId = s.webhookId;
      try {
        const result = await ensureSubscription({
          orgId,
          userId: s.userId,
          scope: s.scope as "org" | "user",
          token,
          targetUrl,
          resource: s.resource,
          event: s.event,
          forceRecreate: true,
        });
        // Only count as recreated if Webex actually issued a new id
        // (or transitioned an error row to active).
        if (
          result.status === "active" &&
          result.webhookId &&
          result.webhookId !== previousWebhookId
        ) {
          recreated++;
        } else if (result.status === "error") {
          errors++;
        }
      } catch (e) {
        errors++;
        log(`refresh recreate failed sub=${s.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (checked > 0) {
    log(`refresh: checked=${checked} recreated=${recreated} errors=${errors}`);
  }
  return { checked, recreated, errors };
}

// ─── Receiver: handle incoming notification ─────────────────────────────────

export interface IncomingWebexNotification {
  /**
   * Webex webhook subscription id — matches what we stored in
   * `webex_webhook_subscriptions.webhook_id` at create time.
   *
   * IMPORTANT: per the Webex Webhooks v1 spec, the top-level `id`
   * field IS the webhook subscription id (not a per-delivery event id).
   * Webex does not send a per-delivery unique id in the standard
   * payload — we derive one ourselves from a hash of the raw body.
   */
  id?: string;
  name?: string;
  resource?: string;
  event?: string;
  targetUrl?: string;
  /** The Webex organization the notification was generated under. */
  orgId?: string;
  /** The Webex person who triggered the event (caller, voicemail recipient, etc.) */
  actorId?: string;
  createdBy?: string;
  appId?: string;
  ownedBy?: string;
  /** ISO timestamp Webex created the notification. Useful for the dedupe hash. */
  created?: string;
  /** The actual changed-resource details — shape varies by resource. */
  data?: { id?: string; [k: string]: unknown };
  [k: string]: unknown;
}

interface ReceiveResult {
  ok: true;
  status: "accepted" | "duplicate" | "unknown_subscription" | "invalid_signature";
  eventDbId?: string;
  subscriptionId?: string;
}

/**
 * Process one Webex notification — verify HMAC, persist, dispatch.
 * Always returns ok=true so the caller can immediately ACK 200; failures
 * are recorded on the event row (process_error) for debugging.
 */
export async function receiveWebexNotification(args: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  notification: IncomingWebexNotification;
}): Promise<ReceiveResult> {
  const { rawBody, signatureHeader, notification } = args;

  // Webex's top-level `id` is the WEBHOOK SUBSCRIPTION id (matches what
  // we stored as webex_webhook_subscriptions.webhook_id). It is NOT a
  // per-delivery event id — every delivery for the same subscription
  // shares the same `id`. Therefore we must derive our own per-delivery
  // dedupe key from the raw body (content-addressed), otherwise only
  // the first event per subscription would be processed.
  const webhookId = typeof notification.id === "string" ? notification.id : undefined;
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const eventId = `${webhookId ?? "unknown"}:${bodyHash}`;
  const resource = notification.resource ?? "unknown";
  const event = notification.event ?? "unknown";
  const resourceId = (notification.data && typeof notification.data === "object" && typeof notification.data.id === "string")
    ? (notification.data.id as string)
    : null;

  if (!webhookId) {
    log(`Notification missing top-level id (webhook subscription id) — recording for debug only`);
    const { row } = await storage.insertWebexWebhookEvent({
      eventId,
      subscriptionId: null,
      orgId: null,
      userId: null,
      resource,
      event,
      resourceId,
      payload: notification as unknown as Record<string, unknown>,
      signatureValid: false,
      processedAt: new Date(),
      processError: "missing_webhook_id",
    });
    return { ok: true, status: "unknown_subscription", eventDbId: row?.id };
  }

  // Look up our subscription row by Webex webhook id
  // (need a small index — for now scan by org list is overkill, so we
  // do a direct query via the storage layer's listWebexWebhookSubscriptions
  // is per-org; fall back to a direct findByWebhookId via a tiny helper).
  const sub = await findSubscriptionByWebhookId(webhookId);
  if (!sub) {
    log(`Notification for unknown webhook id ${webhookId} — ignoring`);
    const { row } = await storage.insertWebexWebhookEvent({
      eventId,
      subscriptionId: null,
      orgId: null,
      userId: null,
      resource,
      event,
      resourceId,
      payload: notification as unknown as Record<string, unknown>,
      signatureValid: false,
      processedAt: new Date(),
      processError: "unknown_webhook_id",
    });
    return { ok: true, status: "unknown_subscription", eventDbId: row?.id };
  }

  const signatureValid = verifyWebexSignature(rawBody, signatureHeader, sub.secret);
  if (!signatureValid) {
    log(`Invalid signature for webhook ${webhookId} (sub=${sub.id})`);
    const { row } = await storage.insertWebexWebhookEvent({
      eventId,
      subscriptionId: sub.id,
      orgId: sub.orgId,
      userId: sub.userId,
      resource,
      event,
      resourceId,
      payload: notification as unknown as Record<string, unknown>,
      signatureValid: false,
      processedAt: new Date(),
      processError: "invalid_signature",
    });
    return { ok: true, status: "invalid_signature", eventDbId: row?.id, subscriptionId: sub.id };
  }

  const inserted = await storage.insertWebexWebhookEvent({
    eventId,
    subscriptionId: sub.id,
    orgId: sub.orgId,
    userId: sub.userId,
    resource,
    event,
    resourceId,
    payload: notification as unknown as Record<string, unknown>,
    signatureValid: true,
  });

  if (!inserted.inserted) {
    return { ok: true, status: "duplicate", eventDbId: inserted.row?.id, subscriptionId: sub.id };
  }

  // Update the subscription's "last event" stamp immediately (sync — the
  // adaptive poller reads this).
  await storage.recordWebexWebhookHit(sub.id, new Date());

  // Dispatch async — don't await.
  void dispatchWebexEvent(inserted.row.id, sub, notification, resource, event, resourceId).catch(err => {
    log(`dispatch error event=${inserted.row.id}: ${err instanceof Error ? err.message : String(err)}`);
  });

  return { ok: true, status: "accepted", eventDbId: inserted.row.id, subscriptionId: sub.id };
}

// Internal: cheap lookup of subscription by webhook id. We don't have a
// dedicated storage method; iterate over org rows. Acceptable since the
// total number of subscriptions per app is bounded by Webex (~100).
async function findSubscriptionByWebhookId(webhookId: string): Promise<WebexWebhookSubscription | null> {
  // Walk distinct orgs that have any sub. We piggyback on getOrganizations
  // for simplicity.
  const orgs = await storage.getOrganizations();
  for (const org of orgs) {
    const subs = await storage.listWebexWebhookSubscriptions(org.id);
    const match = subs.find(s => s.webhookId === webhookId);
    if (match) return match;
  }
  return null;
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

async function dispatchWebexEvent(
  eventDbId: string,
  sub: WebexWebhookSubscription,
  notification: IncomingWebexNotification,
  resource: string,
  event: string,
  resourceId: string | null,
): Promise<void> {
  try {
    if (resource === "telephony_calls") {
      await handleTelephonyCallsEvent(sub, notification, event, resourceId);
    } else if (resource === "voicemails") {
      await handleVoicemailsEvent(sub, notification, event, resourceId);
    } else {
      // Unknown resource — record but treat as success (no-op).
      log(`Unknown resource ${resource} on event ${eventDbId}`);
    }
    await storage.markWebexWebhookEventProcessed(eventDbId, null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await storage.markWebexWebhookEventProcessed(eventDbId, msg.slice(0, 500));
    throw err;
  }
}

/**
 * Telephony call event → ingest the call record AND enqueue enrichment.
 *
 * IMPORTANT: just enqueueing an enrichment job is not enough — the
 * enrichment worker (`mergeWebexCallEnrichment`) is a no-op when no
 * base `webex_call_analytics` row exists yet. So before enqueuing the
 * enrichment job we run a small (1-hour window) `syncCallsForOrg`
 * which:
 *   - calls `fetchCallHistory` (CDR API) for the relevant token,
 *   - runs `persistCallAnalytics` for every record (upsert — safe to
 *     repeat), creating the base row, the touchpoint, NBA cards, etc.,
 *   - then we layer enrichment on top so recording/MOS/Whisper land
 *     within the worker's next sweep (~30s).
 *
 * This mirrors exactly what the 30-min poller does, just narrowly
 * scoped to the past hour. It's idempotent — duplicate webhooks for
 * the same call simply re-upsert the same row.
 *
 * Dynamic import avoids a circular dep with `routes/webex.ts`
 * (that file imports this service for subscription lifecycle).
 */
async function handleTelephonyCallsEvent(
  sub: WebexWebhookSubscription,
  _notification: IncomingWebexNotification,
  _event: string,
  callId: string | null,
): Promise<void> {
  if (!callId) return;

  // Resolve the right token. User-scoped subs MUST use the user's token
  // (org token can't see personal CDRs); org-scoped uses the admin token.
  let userScope: { userId: string; accessToken: string } | undefined;
  if (sub.scope === "user" && sub.userId) {
    const t = await getUserWebexAccessToken(sub.userId);
    if (t) userScope = { userId: sub.userId, accessToken: t.token };
  }

  // Run the full ingestion path. We use a 1-hour lookback window so
  // even a slightly delayed webhook (e.g., during a brief outage) still
  // captures the call. Org-token sync covers all users; user-token sync
  // covers only that rep's calls.
  //
  // We capture the ingest error (if any) but defer rethrowing until
  // AFTER we've best-effort enqueued enrichment — that way the enrichment
  // worker still has a queued job to retry once the base row eventually
  // lands (via the 30-min fallback poller). The captured error is then
  // propagated to `dispatchWebexEvent` so `process_error` is recorded
  // truthfully on the event row, which keeps `webhooksHealthy()` from
  // counting failed ingestions as healthy push traffic and suppressing
  // the polling fallback (Task #741 defect #10).
  let ingestError: Error | null = null;
  try {
    const { syncCallsForOrg } = await import("./routes/webex");
    await syncCallsForOrg(sub.orgId, 1, undefined, userScope ? { forUser: userScope } : undefined);
  } catch (err) {
    ingestError = err instanceof Error ? err : new Error(String(err));
    log(`telephony ingest failed call=${callId}: ${ingestError.message}`);
  }

  // Best-effort enrichment enqueue regardless of ingest outcome.
  try {
    await enqueueEnrichmentJob(sub.orgId, callId, sub.userId);
  } catch (err) {
    log(`enrichment enqueue failed call=${callId}: ${err instanceof Error ? err.message : String(err)}`);
    if (!ingestError) ingestError = err instanceof Error ? err : new Error(String(err));
  }

  if (ingestError) throw ingestError;
}

/**
 * Voicemail event → upsert the row + (best-effort) trigger transcription.
 * The full transcription pipeline already exists; we just stamp the
 * voicemail metadata so downstream batch jobs find it on their next pass.
 *
 * If we have a per-user token we fetch the audio inline (cheap — small
 * file) so Whisper transcription kicks off within seconds instead of
 * waiting for the next 30-min poll.
 */
async function handleVoicemailsEvent(
  sub: WebexWebhookSubscription,
  notification: IncomingWebexNotification,
  event: string,
  voicemailId: string | null,
): Promise<void> {
  if (!voicemailId) return;
  if (event === "deleted") {
    // Nothing to ingest — leave existing rows intact.
    return;
  }
  // Best-effort: fetch + persist metadata. This is a transcription
  // hint, not the source of truth.
  let token: string | null = null;
  if (sub.scope === "user" && sub.userId) {
    const t = await getUserWebexAccessToken(sub.userId);
    token = t?.token ?? null;
  }
  if (!token && hasWebexTokens() && !webexNeedsReauth()) {
    try { token = await getWebexAccessToken(); } catch { token = null; }
  }
  if (!token) {
    // No token — the next scheduled voicemail poll will pick it up.
    return;
  }
  // Trigger an inline metadata persist + audio fetch via existing helper.
  // We intentionally don't await the Whisper transcription — that's a
  // separate background pipeline.
  //
  // We rethrow on failure so `dispatchWebexEvent` records `process_error`
  // truthfully. Otherwise `webhooksHealthy()` would treat a long string
  // of failed voicemail ingestions as healthy push traffic and suppress
  // the polling fallback (Task #741 defect #10).
  const audio = await fetchVoicemailAudio(token, voicemailId);
  const data = (notification.data ?? {}) as Record<string, unknown>;
  const callerName = typeof data.callerName === "string" ? (data.callerName as string) : null;
  const callerNumber = typeof data.callerNumber === "string" ? (data.callerNumber as string) : null;
  const callId = typeof data.callId === "string" ? (data.callId as string) : null;
  const duration = typeof data.duration === "number" ? (data.duration as number) : 0;
  await storage.upsertWebexVoicemail({
    orgId: sub.orgId,
    userId: sub.userId ?? null,
    voicemailId,
    callId,
    callerName,
    callerNumber,
    receivedAt: new Date(),
    durationSeconds: duration,
    read: false,
    transcript: null,
    transcriptionStatus: audio ? "pending" : "failed",
    audioCached: !!audio,
  });
}

// ─── Adaptive poller helper ─────────────────────────────────────────────────

/**
 * True iff this org has received a webhook event in the last `windowMin`
 * minutes (default 15). The adaptive poller uses this to skip its CDR
 * sweep when push notifications are flowing, then snap back to polling
 * when events go quiet.
 */
export async function webhooksHealthy(orgId: string, windowMin = 15): Promise<boolean> {
  const last = await storage.getLatestWebexWebhookEventAt(orgId);
  if (!last) return false;
  const ageMs = Date.now() - last.getTime();
  return ageMs < windowMin * 60_000;
}
