/**
 * Microsoft Graph Inbound Email Webhook — Task #183 / #230
 *
 * Handles Microsoft Graph change notifications for inbound emails from:
 *   1. The shared reply-tracking mailbox (carrier emails)
 *   2. Individual NAM/AM monitored mailboxes (customer email auto-sync)
 *
 * For monitored user mailboxes (Task #230):
 *   - Identifies which user's mailbox the email arrived in
 *   - Matches sender/recipient against known customer contacts
 *   - Creates email_message and conversation thread records with proper ownership
 *   - Deduplicates against already-tracked messages
 *   - AI signal extraction runs automatically via the background scheduler
 */

import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import type { EmailConversationThread, EmailMessage } from "@shared/schema";
import type { ConversationOwnershipStorage } from "../services/conversationOwnershipService";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [graphWebhook] ${msg}`);
}

export interface MatchResult {
  carrierId: string | null;
  contactId: string | null;
  confidence: "exact" | "alternate_contact" | "ambiguous" | "unmatched";
}

export async function matchInboundSender(fromEmail: string, orgId: string): Promise<MatchResult> {
  const normalized = fromEmail.trim().toLowerCase();

  const primaryMatches = await storage.getCarriersByPrimaryEmail(normalized, orgId);
  if (primaryMatches.length === 1) {
    return { carrierId: primaryMatches[0].id, contactId: null, confidence: "exact" };
  }
  if (primaryMatches.length > 1) {
    return { carrierId: null, contactId: null, confidence: "ambiguous" };
  }

  const contactMatch = await storage.getCarrierContactByEmail(normalized, orgId);
  if (contactMatch) {
    return { carrierId: contactMatch.carrierId, contactId: contactMatch.id, confidence: "alternate_contact" };
  }

  return { carrierId: null, contactId: null, confidence: "unmatched" };
}

export async function matchInboundSenderToAccount(
  fromEmail: string,
  orgId: string
): Promise<{ companyId: string; contactId: string; contactName: string } | null> {
  const normalized = fromEmail.trim().toLowerCase();
  return storage.getContactByEmailInOrg(normalized, orgId);
}

// ── Free / personal email providers we never treat as account domains ────────
const FREE_PROVIDERS_FOR_DOMAIN_MATCH = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
  "aol.com", "live.com", "msn.com", "me.com", "ymail.com",
  "protonmail.com", "proton.me",
]);

function normalizeDomainForMatch(raw: string): string {
  return raw.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
}

/**
 * Fallback: when an email's sender (or counterparty) isn't in our CRM
 * contacts, try matching their email DOMAIN against a known company's
 * website / name in the org. This lets unknown senders at known accounts
 * get linked → which then triggers the contact-suggestion pipeline so
 * the NAM/AM is prompted to add them as a real contact.
 *
 * Returns the best matching companyId or null.
 */
export async function matchAccountByEmailDomain(
  emailAddress: string,
  orgId: string,
): Promise<string | null> {
  const domain = emailAddress.split("@")[1]?.toLowerCase().trim();
  if (!domain) return null;
  if (FREE_PROVIDERS_FOR_DOMAIN_MATCH.has(domain)) return null;

  const companies = await storage.getCompanies(orgId).catch(() => [] as Awaited<ReturnType<typeof storage.getCompanies>>);
  let bestId: string | null = null;
  let bestScore = 0;
  let tied = false;

  for (const c of companies) {
    // Webhook-time linking only accepts strong WEBSITE/DOMAIN evidence
    // (>=25). Name-only heuristic matches are intentionally excluded here
    // because they're too weak to auto-link a conversation to an account
    // — the contact-suggestion service still uses them for scoring once
    // a message is linked some other way.
    let score = 0;
    if (c.website) {
      const site = normalizeDomainForMatch(c.website);
      if (site === domain) score = 30;
      else if (site && (domain.endsWith("." + site) || site.endsWith("." + domain))) score = 25;
    }
    if (score === 0) continue;

    if (score > bestScore) {
      bestScore = score;
      bestId = c.id;
      tied = false;
    } else if (score === bestScore && c.id !== bestId) {
      tied = true;
    }
  }

  // Ambiguity guard: if two or more companies tie at the top score,
  // refuse to link rather than risk attaching to the wrong account.
  if (tied) {
    log(`[user-mailbox] Domain-match ambiguous for ${emailAddress} — multiple companies share domain, skipping fallback`);
    return null;
  }

  return bestId;
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

interface GraphMessageDetails {
  id: string;
  conversationId?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string; contentType?: string };
  receivedDateTime?: string;
  internetMessageId?: string;
}

async function fetchGraphMessage(resource: string): Promise<GraphMessageDetails | null> {
  try {
    const resourceMatch = resource.match(/users\/([^/]+)\/.*messages\/([^/]+)/);
    if (!resourceMatch) return null;

    const mailbox = decodeURIComponent(resourceMatch[1]);
    const msgId = decodeURIComponent(resourceMatch[2]);

    const { getGraphAccessToken } = await import("../graphService");
    const token = await getGraphAccessToken();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(msgId)}?$select=id,conversationId,from,toRecipients,subject,bodyPreview,body,receivedDateTime,internetMessageId`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      return await res.json() as GraphMessageDetails;
    }
    const errText = await res.text();
    log(`Graph message fetch error ${res.status}: ${errText}`);
    return null;
  } catch (err) {
    log(`Graph message fetch exception: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function processNotification(notification: GraphNotificationValue, orgId: string): Promise<void> {
  const resourceDataId = notification.resourceData?.id;
  if (!resourceDataId) {
    log("Notification missing resourceData.id — skipping");
    return;
  }

  const existing = await storage.getCarrierOutreachLogByProviderMessageId(resourceDataId);
  if (existing) {
    log(`Duplicate message ID ${resourceDataId} — skipping (idempotent)`);
    return;
  }

  const resource = notification.resource ?? "";
  const messageDetails = await fetchGraphMessage(resource);

  const fromEmail = messageDetails?.from?.emailAddress?.address ?? "";
  const fromName = messageDetails?.from?.emailAddress?.name ?? "";
  const toEmail = messageDetails?.toRecipients?.[0]?.emailAddress?.address ?? "";
  const subject = messageDetails?.subject ?? "";
  const bodyPreview = messageDetails?.bodyPreview?.slice(0, 255) ?? "";
  const bodyFull = messageDetails?.body?.content ?? bodyPreview;
  const conversationId = messageDetails?.conversationId ?? null;
  const providerMessageId = messageDetails?.id ?? resourceDataId;
  const receivedAt = messageDetails?.receivedDateTime ? new Date(messageDetails.receivedDateTime) : new Date();

  // Microsoft Graph delivers SentItems notifications with inconsistent casing
  // (`Users/...` vs `users/...`) and the path segment may be either the
  // mailbox email OR the user's Azure AD object ID (UUID). Match
  // case-insensitively, and when the path is a UUID, fall back to looking up
  // the monitored mailbox by Azure user id instead of email.
  const resourceMailbox = resource.match(/users\/([^/]+)\//i);
  const rawMailboxSegment = resourceMailbox ? decodeURIComponent(resourceMailbox[1]) : "";
  const isUuidSegment = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawMailboxSegment);
  const mailboxEmail = !isUuidSegment ? rawMailboxSegment.toLowerCase() : "";

  let monitoredMailbox = mailboxEmail
    ? await storage.getMonitoredMailboxByEmail(orgId, mailboxEmail).catch(() => null)
    : null;

  // Subscription-id resolution path (already used by the outer caller) — when
  // the resource segment is a UUID we cannot look up by email, but the
  // notification's subscriptionId pins us to a specific monitored mailbox.
  if (!monitoredMailbox && notification.subscriptionId) {
    monitoredMailbox = await storage
      .getMonitoredMailboxByAnySubscriptionId(notification.subscriptionId)
      .catch(() => null) ?? null;
  }

  if (monitoredMailbox) {
    const allToRecipients = (messageDetails?.toRecipients ?? [])
      .map(r => r.emailAddress?.address)
      .filter((a): a is string => !!a);
    await processUserMailboxEmail({
      orgId,
      monitoredMailbox,
      fromEmail,
      fromName,
      toEmail,
      allToRecipients,
      subject,
      bodyPreview,
      bodyFull,
      conversationId,
      providerMessageId,
      receivedAt,
      mailboxEmail,
    });
    return;
  }

  const carrierMatch = await matchInboundSender(fromEmail, orgId);

  const accountMatch = carrierMatch.carrierId
    ? null
    : await matchInboundSenderToAccount(fromEmail, orgId);

  let laneId: string | null = null;
  if (conversationId && carrierMatch.carrierId) {
    const outboundLog = await storage.getCarrierOutreachLogByConversationId(conversationId, orgId);
    if (outboundLog) {
      laneId = outboundLog.laneId ?? null;
    }
  }

  const systemUser = await storage.getFirstOrgAdmin(orgId);
  if (!systemUser) {
    log(`No admin user found for org ${orgId} — cannot create inbound log`);
    return;
  }

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

  if (accountMatch) {
    await storage.insertEmailMessage({
      orgId,
      providerMessageId,
      threadId: conversationId,
      direction: "inbound",
      fromEmail,
      toEmail,
      subject,
      body: bodyPreview,
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

  if (carrierMatch.confidence === "unmatched" && !accountMatch) {
    log(`Unmatched inbound email: from=${fromEmail} msgId=${providerMessageId} — no carrier or CRM contact found`);
  }
}

async function processUserMailboxEmail(params: {
  orgId: string;
  monitoredMailbox: { id: string; userId: string; email: string };
  fromEmail: string;
  fromName: string;
  toEmail: string;
  allToRecipients?: string[];
  subject: string;
  bodyPreview: string;
  bodyFull: string;
  conversationId: string | null;
  providerMessageId: string;
  receivedAt: Date;
  mailboxEmail: string;
}): Promise<void> {
  const {
    orgId, monitoredMailbox, fromEmail, fromName, toEmail, allToRecipients, subject,
    bodyPreview, bodyFull, conversationId, providerMessageId, receivedAt, mailboxEmail,
  } = params;

  const isFromMailboxOwner = fromEmail.toLowerCase() === mailboxEmail.toLowerCase();
  const direction = isFromMailboxOwner ? "outbound" : "inbound";

  const counterpartyEmails = isFromMailboxOwner
    ? [...new Set([toEmail, ...(allToRecipients ?? [])].filter(Boolean))]
    : [fromEmail];

  // First: if we already track a conversation thread for this Outlook
  // conversationId, ALWAYS save the new message and use the thread's
  // linkedAccountId as the source of truth. This preserves thread continuity
  // even when the customer counterparty isn't a perfect CRM contact match,
  // or when the linked account is assigned to a different rep.
  let existingThreadExists = false;
  let existingThreadAccountId: string | null = null;
  if (conversationId) {
    const existingThreadEarly = await storage.getEmailConversationThreadByThreadId(orgId, conversationId);
    if (existingThreadEarly) {
      existingThreadExists = true;
      existingThreadAccountId = existingThreadEarly.linkedAccountId ?? null;
    }
  }

  let accountMatch: { companyId: string; contactId: string; contactName: string } | null = null;
  for (const email of counterpartyEmails) {
    accountMatch = await matchInboundSenderToAccount(email, orgId);
    if (accountMatch) break;
  }

  // If no contact match but we already have a thread with a linked account,
  // synthesize an accountMatch from the thread's linkedAccountId so the
  // message is saved with the correct account link.
  if (!accountMatch && existingThreadAccountId) {
    accountMatch = {
      companyId: existingThreadAccountId,
      contactId: "",
      contactName: "",
    };
  }

  // Domain-match fallback: if still no match, try matching the counterparty's
  // email domain against a known company in the org. This is the critical
  // path for "unknown sender at known account" — the message gets linked to
  // the account so the contact-suggestion pipeline can prompt the rep to
  // add this person as a real contact.
  if (!accountMatch) {
    for (const email of counterpartyEmails) {
      const matchedCompanyId = await matchAccountByEmailDomain(email, orgId);
      if (matchedCompanyId) {
        accountMatch = { companyId: matchedCompanyId, contactId: "", contactName: "" };
        log(`[user-mailbox] Domain-match fallback linked email from ${email} → company ${matchedCompanyId}`);
        break;
      }
    }
  }

  // If we have neither a contact match nor an existing thread, drop the
  // message — there's nothing to link it to. (If the thread exists but has
  // no linkedAccountId, we still save the message below with linkedAccountId
  // = null so the thread continuity is preserved.)
  if (!accountMatch && !existingThreadExists) {
    return;
  }

  // Skip the "is this account assigned to this rep?" gate when:
  //   (a) we already have an active thread for this conversation (continuity),
  //   OR
  //   (b) this is the rep's own outbound reply (they explicitly sent it from
  //       their own monitored mailbox — always record it).
  if (!existingThreadExists && direction !== "outbound" && accountMatch) {
    const company = await storage.getCompany(accountMatch.companyId);
    if (company && company.assignedTo && company.assignedTo !== monitoredMailbox.userId) {
      log(`[user-mailbox] Skipping email — account ${accountMatch.companyId} is assigned to ${company.assignedTo}, not ${monitoredMailbox.userId}`);
      return;
    }
  }

  const { message, created } = await storage.upsertInboundEmailMessage({
    orgId,
    providerMessageId,
    threadId: conversationId,
    direction,
    fromEmail,
    toEmail,
    subject,
    body: bodyFull.slice(0, 5000),
    linkedAccountId: accountMatch?.companyId ?? null,
    linkedCarrierId: null,
    linkedLaneId: null,
    linkedLoadId: null,
    linkedTaskId: null,
    linkedNbaId: null,
    linkedOutreachLogId: null,
    processedForSignalsAt: null,
  });

  if (!created) {
    log(`[user-mailbox] Duplicate email skipped: msgId=${providerMessageId}`);
    return;
  }

  log(`[user-mailbox] ${direction} email recorded: from=${fromEmail} to=${toEmail} account=${accountMatch?.companyId ?? "(none)"} msgId=${providerMessageId}`);

  if (conversationId) {
    try {
      const { applyMessageToThread } = await import("../services/conversationWaitingStateService");
      const { determineInitialOwner } = await import("../services/conversationOwnershipService");

      const existingThread = await storage.getEmailConversationThreadByThreadId(orgId, conversationId);
      const now = new Date();

      const threadBase: EmailConversationThread = existingThread ?? {
        id: "", orgId, threadId: conversationId,
        linkedAccountId: accountMatch?.companyId ?? null, linkedCarrierId: null,
        ownerUserId: monitoredMailbox.userId,
        waitingState: "waiting_on_us",
        responsePriority: "normal", lastMessageId: null,
        lastIncomingAt: null, lastOutgoingAt: null,
        waitingSinceAt: null, overdueAt: null, createdAt: now, updatedAt: now,
      };

      const update = applyMessageToThread(threadBase, message, now);

      let ownerUserId = existingThread?.ownerUserId ?? monitoredMailbox.userId;
      if (!existingThread) {
        const ownershipStorage: ConversationOwnershipStorage = {
          getCompany: (id: string) => storage.getCompany(id),
          getUser: (id: string) => storage.getUser(id),
          upsertEmailConversationThread: (data) => storage.upsertEmailConversationThread(data),
        };
        const determined = await determineInitialOwner(message, orgId, ownershipStorage).catch(() => null);
        ownerUserId = determined ?? monitoredMailbox.userId;
      }

      await storage.upsertEmailConversationThread({
        orgId,
        threadId: conversationId,
        linkedAccountId: accountMatch.companyId,
        linkedCarrierId: null,
        update: { ...update, ownerUserId },
      });

      log(`[user-mailbox] Conversation thread upserted: threadId=${conversationId} owner=${ownerUserId}`);
    } catch (convErr) {
      log(`[user-mailbox] Conversation upsert error: ${convErr instanceof Error ? convErr.message : String(convErr)}`);
    }
  }

  await storage.updateMonitoredMailbox(monitoredMailbox.id, {
    lastSyncAt: new Date(),
  });
}

export { processUserMailboxEmail as processUserMailboxEmailForDelta };

export async function processGraphNotifications(body: unknown): Promise<void> {
  const expectedClientState = process.env.OUTLOOK_WEBHOOK_SECRET ?? process.env.GRAPH_WEBHOOK_CLIENT_STATE ?? "";
  const payload = body as GraphNotificationPayload | null | undefined;
  const notifications = payload?.value;
  if (!Array.isArray(notifications) || notifications.length === 0) {
    return;
  }

  for (const notification of notifications) {
    if (expectedClientState && notification.clientState !== expectedClientState) {
      log(`Invalid clientState "${notification.clientState}" — ignoring notification`);
      continue;
    }

    const resource = notification.resource ?? "";
    // Microsoft Graph delivers notifications with inconsistent casing
    // (sometimes `users/...`, sometimes `Users/...`) and may use either the
    // mailbox email or the user's Azure AD object ID as the path segment.
    // Match case-insensitively so SentItems notifications resolve correctly.
    const mailboxMatch = resource.match(/users\/([^/]+)\//i);
    const mailbox = mailboxMatch ? decodeURIComponent(mailboxMatch[1]) : null;

    let orgId: string | null = null;
    let resolvedVia: string | null = null;

    if (notification.subscriptionId) {
      const monitoredMb = await storage.getMonitoredMailboxByAnySubscriptionId(notification.subscriptionId).catch(() => null);
      if (monitoredMb) {
        orgId = monitoredMb.orgId;
        resolvedVia = "subscriptionId";
      }
    }

    if (!orgId && mailbox && mailbox.includes("@")) {
      const org = await storage.getOrgByOutlookMailbox(mailbox).catch(() => null);
      if (org) {
        orgId = org.id;
        resolvedVia = "mailboxEmail";
      }
    }

    if (!orgId) {
      log(`Could not resolve org for resource "${resource}" subId=${notification.subscriptionId ?? "(none)"} — skipping (no matching monitored mailbox or org)`);
      continue;
    }
    if (resolvedVia) {
      // Lightweight breadcrumb so we can confirm SentItems subscriptions are firing.
      log(`Notification accepted via ${resolvedVia} subId=${notification.subscriptionId ?? "(none)"} resource="${resource.slice(0, 80)}"`);
    }

    processNotification(notification, orgId).catch(err => {
      log(`processNotification error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

export function registerGraphWebhookRoutes(app: Express): void {
  app.get("/api/webhooks/graph/email", (req: Request, res: Response) => {
    const validationToken = req.query.validationToken as string | undefined;
    if (validationToken) {
      res.set("Content-Type", "text/plain");
      return res.status(200).send(validationToken);
    }
    return res.status(200).json({ ok: true });
  });
}
