/**
 * Microsoft Graph Inbound Email Webhook — Task #183 / Customer Email Extension
 *
 * Handles Microsoft Graph change notifications for inbound emails. When an email
 * arrives in a monitored mailbox, Graph POSTs a notification to this endpoint.
 *
 * Security:
 *   - Validation token handshake (GET + POST clientState)
 *   - Org-scoped org lookup via GRAPH_WEBHOOK_CLIENT_STATE env var
 *
 * Idempotency:
 *   - providerMessageId unique index prevents duplicate processing
 *
 * Carrier matching (confidence levels):
 *   exact             — sender email matches carrier primary_email
 *   alternate_contact — sender email matches a carrier_contacts.email
 *   ambiguous         — sender email matches multiple carriers
 *   unmatched         — no carrier found
 *
 * Customer contact matching:
 *   When sender does not match a carrier, the webhook falls through to check
 *   the CRM contacts table. If matched, an email_message row is inserted so
 *   the AI intelligence scheduler can extract customer intent signals.
 *
 * Lane association:
 *   - Looks up an outbound outreach log with matching conversationId
 *   - Inherits laneId from that log if found; null otherwise
 */

import type { Express, Request, Response } from "express";
import { storage } from "../storage";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [graphWebhook] ${msg}`);
}

export interface MatchResult {
  carrierId: string | null;
  contactId: string | null;
  confidence: "exact" | "alternate_contact" | "ambiguous" | "unmatched";
}

/**
 * Match an inbound sender email address to a carrier in the given org.
 * Confidence levels:
 *   exact             — sender matches carrier.primary_email (1 carrier)
 *   alternate_contact — sender matches a carrier_contacts.email row
 *   ambiguous         — multiple carriers share that email
 *   unmatched         — no match
 */
export async function matchInboundSender(fromEmail: string, orgId: string): Promise<MatchResult> {
  const normalized = fromEmail.trim().toLowerCase();

  // 1. Check carrier primary_email (org-scoped)
  const primaryMatches = await storage.getCarriersByPrimaryEmail(normalized, orgId);
  if (primaryMatches.length === 1) {
    return { carrierId: primaryMatches[0].id, contactId: null, confidence: "exact" };
  }
  if (primaryMatches.length > 1) {
    return { carrierId: null, contactId: null, confidence: "ambiguous" };
  }

  // 2. Check carrier_contacts.email (org-scoped)
  const contactMatch = await storage.getCarrierContactByEmail(normalized, orgId);
  if (contactMatch) {
    return { carrierId: contactMatch.carrierId, contactId: contactMatch.id, confidence: "alternate_contact" };
  }

  return { carrierId: null, contactId: null, confidence: "unmatched" };
}

/**
 * Match an inbound sender email to a CRM customer contact in the given org.
 * Returns company and contact IDs if found, null otherwise.
 */
export async function matchInboundSenderToAccount(
  fromEmail: string,
  orgId: string
): Promise<{ companyId: string; contactId: string; contactName: string } | null> {
  const normalized = fromEmail.trim().toLowerCase();
  return storage.getContactByEmailInOrg(normalized, orgId);
}

interface GraphNotificationValue {
  clientState?: string;
  subscriptionId?: string;
  changeType?: string;
  resourceData?: {
    id?: string;
    "@odata.type"?: string;
  };
  resource?: string;
}

interface GraphNotificationPayload {
  value?: GraphNotificationValue[];
}

async function processNotification(notification: GraphNotificationValue, orgId: string): Promise<void> {
  const resourceDataId = notification.resourceData?.id;
  if (!resourceDataId) {
    log("Notification missing resourceData.id — skipping");
    return;
  }

  // Idempotency check: have we already processed this message?
  const existing = await storage.getCarrierOutreachLogByProviderMessageId(resourceDataId);
  if (existing) {
    log(`Duplicate message ID ${resourceDataId} — skipping (idempotent)`);
    return;
  }

  // Fetch full message from Graph
  let messageDetails: {
    id: string;
    conversationId?: string;
    from?: { emailAddress?: { address?: string; name?: string } };
    toRecipients?: Array<{ emailAddress?: { address?: string } }>;
    subject?: string;
    bodyPreview?: string;
    receivedDateTime?: string;
    internetMessageId?: string;
  } | null = null;

  try {
    // resource looks like: users/{mailbox}/messages/{id}
    const resource = notification.resource ?? "";
    const resourceMatch = resource.match(/users\/([^/]+)\/messages\/([^/]+)/);
    if (resourceMatch) {
      const mailbox = decodeURIComponent(resourceMatch[1]);
      const msgId = decodeURIComponent(resourceMatch[2]);

      const { getGraphAccessToken } = await import("../graphService");
      const token = await getGraphAccessToken();
      const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(msgId)}?$select=id,conversationId,from,toRecipients,subject,bodyPreview,receivedDateTime,internetMessageId`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        messageDetails = await res.json() as typeof messageDetails;
      } else {
        const errText = await res.text();
        log(`Graph message fetch error ${res.status}: ${errText}`);
      }
    }
  } catch (err) {
    log(`Graph message fetch exception: ${err instanceof Error ? err.message : String(err)}`);
  }

  const fromEmail = messageDetails?.from?.emailAddress?.address ?? "";
  const toEmail = messageDetails?.toRecipients?.[0]?.emailAddress?.address ?? "";
  const subject = messageDetails?.subject ?? "";
  const bodyPreview = messageDetails?.bodyPreview?.slice(0, 255) ?? "";
  const conversationId = messageDetails?.conversationId ?? null;
  const providerMessageId = messageDetails?.id ?? resourceDataId;
  const receivedAt = messageDetails?.receivedDateTime ? new Date(messageDetails.receivedDateTime) : new Date();

  // Match sender to carrier
  const carrierMatch = await matchInboundSender(fromEmail, orgId);

  // Also try matching sender to CRM customer contact (independent of carrier match)
  const accountMatch = carrierMatch.carrierId
    ? null // Already a carrier — skip CRM contact lookup
    : await matchInboundSenderToAccount(fromEmail, orgId);

  // Lane association via conversationId (carrier path only)
  let laneId: string | null = null;
  if (conversationId && carrierMatch.carrierId) {
    const outboundLog = await storage.getCarrierOutreachLogByConversationId(conversationId, orgId);
    if (outboundLog) {
      laneId = outboundLog.laneId ?? null;
    }
  }

  // We need a system actor user — use the first admin of the org.
  const systemUser = await storage.getFirstOrgAdmin(orgId);
  if (!systemUser) {
    log(`No admin user found for org ${orgId} — cannot create inbound log`);
    return;
  }

  // ── Path A: Carrier email ─────────────────────────────────────────────────
  if (carrierMatch.carrierId || carrierMatch.confidence !== "unmatched") {
    await storage.createCarrierOutreachLog({
      orgId,
      laneId,
      companyId: null,
      carrierIds: carrierMatch.carrierId ? [carrierMatch.carrierId] : [],
      carrierNames: [],
      actorUserId: systemUser.id,
      ownerUserId: null,
      overseerUserId: null,
      outreachMode: "lane_building",
      emailDrafts: [],
      direction: "inbound",
      providerMessageId,
      conversationId,
      fromEmail,
      toEmail,
      subject,
      bodyPreview,
      receivedAt,
      processStatus: "processed",
      matchedCarrierId: carrierMatch.carrierId,
      matchedLaneId: laneId,
      matchConfidence: carrierMatch.confidence,
      deliveryStatus: "received",
    });
    log(`Carrier inbound logged: from=${fromEmail} confidence=${carrierMatch.confidence} laneId=${laneId ?? "none"} msgId=${providerMessageId}`);
  }

  // ── Path B: Customer / CRM contact email ─────────────────────────────────
  // Insert an email_message row so the AI intelligence scheduler can extract
  // customer intent signals (pricing_request, urgency_signal, new_opportunity, etc.)
  if (accountMatch) {
    await storage.insertEmailMessage({
      orgId,
      providerMessageId,
      threadId: conversationId,
      direction: "inbound",
      fromEmail,
      toEmail,
      subject,
      body: bodyPreview, // bodyPreview truncated to 255; full body fetch can be added later
      linkedAccountId: accountMatch.companyId,
      linkedCarrierId: null,
      linkedLaneId: null,
      linkedLoadId: null,
      linkedTaskId: null,
      linkedNbaId: null,
      linkedOutreachLogId: null,
    });
    log(`Customer inbound email_message created: from=${fromEmail} contact=${accountMatch.contactName} company=${accountMatch.companyId} msgId=${providerMessageId}`);
  }

  // ── Unmatched: log for debugging ─────────────────────────────────────────
  if (carrierMatch.confidence === "unmatched" && !accountMatch) {
    log(`Unmatched inbound email: from=${fromEmail} msgId=${providerMessageId} — no carrier or CRM contact found`);
  }
}

/**
 * processGraphNotifications — exported so index.ts can call it from the raw-body
 * POST handler that is registered before express.json() (required so malformed JSON
 * never reaches Express's JSON parser and causes a 400).
 */
export async function processGraphNotifications(body: unknown): Promise<void> {
  const expectedClientState = process.env.GRAPH_WEBHOOK_CLIENT_STATE ?? "";
  const payload = body as GraphNotificationPayload | null | undefined;
  const notifications = payload?.value;
  if (!Array.isArray(notifications) || notifications.length === 0) {
    return;
  }

  for (const notification of notifications) {
    // Validate clientState to prevent spoofed notifications
    if (expectedClientState && notification.clientState !== expectedClientState) {
      log(`Invalid clientState "${notification.clientState}" — ignoring notification`);
      continue;
    }

    // Determine which org this mailbox belongs to
    const resource = notification.resource ?? "";
    const mailboxMatch = resource.match(/users\/([^/]+)\//);
    const mailbox = mailboxMatch ? decodeURIComponent(mailboxMatch[1]) : null;

    let orgId: string | null = null;
    if (mailbox) {
      const org = await storage.getOrgByOutlookMailbox(mailbox).catch(() => null);
      if (org) orgId = org.id;
    }

    if (!orgId) {
      // Fall back to first org (single-tenant deployments)
      const firstOrg = await storage.getFirstOrg().catch(() => null);
      if (firstOrg) orgId = firstOrg.id;
    }

    if (!orgId) {
      log(`Could not resolve org for resource "${resource}" — skipping`);
      continue;
    }

    processNotification(notification, orgId).catch(err => {
      log(`processNotification error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

export function registerGraphWebhookRoutes(app: Express): void {
  /**
   * GET /api/webhooks/graph/email
   * Microsoft Graph subscription validation handshake.
   * Graph sends ?validationToken=... and expects it echoed back as text/plain with 200.
   */
  app.get("/api/webhooks/graph/email", (req: Request, res: Response) => {
    const validationToken = req.query.validationToken as string | undefined;
    if (validationToken) {
      res.set("Content-Type", "text/plain");
      return res.status(200).send(validationToken);
    }
    return res.status(200).json({ ok: true });
  });

  // NOTE: POST /api/webhooks/graph/email is registered in server/index.ts
  // BEFORE express.json() so that malformed JSON payloads never trigger a 400.
  // The handler there delegates to processGraphNotifications() exported above.
}
