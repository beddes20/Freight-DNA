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
import { getErrorMessage } from "../lib/errors";
import { qOptStr } from "../lib/req";
import {
  matchInboundCarrier,
  normalizeEmailAddress,
} from "../services/carrierContactMatchService";
import { recordIntegrationEvent } from "../integrations/probeRegistry";
import { publish as publishLiveSync } from "../services/liveSync";
import { dispatchInlineClassification } from "../services/inlineEmailClassifier";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [graphWebhook] ${msg}`);
}

export interface MatchResult {
  carrierId: string | null;
  contactId: string | null;
  confidence: "exact" | "alternate_contact" | "domain_fallback" | "ambiguous" | "unmatched";
}

export async function matchInboundSender(fromEmail: string, orgId: string): Promise<MatchResult> {
  const result = await matchInboundCarrier(fromEmail, orgId, storage);
  return {
    carrierId: result.carrierId,
    contactId: result.contactId,
    confidence: result.confidence,
  };
}

export async function matchInboundSenderToAccount(
  fromEmail: string,
  orgId: string
): Promise<{ companyId: string; contactId: string; contactName: string } | null> {
  const normalized = normalizeEmailAddress(fromEmail);
  if (!normalized) return null;
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
    log(`Graph message fetch exception: ${getErrorMessage(err)}`);
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
  const mailboxEmailFromResource = !isUuidSegment ? rawMailboxSegment.toLowerCase() : "";

  let monitoredMailbox = mailboxEmailFromResource
    ? await storage.getMonitoredMailboxByEmail(orgId, mailboxEmailFromResource).catch(() => null)
    : null;

  // Subscription-id resolution path (already used by the outer caller) — when
  // the resource segment is a UUID we cannot look up by email, but the
  // notification's subscriptionId pins us to a specific monitored mailbox.
  if (!monitoredMailbox && notification.subscriptionId) {
    monitoredMailbox = await storage
      .getMonitoredMailboxByAnySubscriptionId(notification.subscriptionId)
      .catch(() => null) ?? null;
  }

  // Task #1002 — when the resource path is a UUID segment, mailboxEmail
  // from the URL is empty. Fall back to the resolved monitored mailbox's
  // email so the downstream `fromEmail === mailboxEmail` direction
  // comparison can correctly distinguish outbound (rep-sent) from
  // inbound (customer reply). Without this fallback the comparison
  // collapses to `"" === ""` whenever fetchGraphMessage also returns no
  // sender, which silently mis-classifies every UUID-path notification
  // as outbound and pollutes email_messages with empty rows that then
  // block the legitimate inbound re-delivery via the unique
  // (org_id, provider_message_id) constraint.
  const mailboxEmail = mailboxEmailFromResource || monitoredMailbox?.email?.toLowerCase() || "";

  // Task #1002 — refuse to persist a row when Graph gave us a notification
  // whose message body we couldn't fetch (deletion race, transient 404, or
  // the not-yet-replicated-to-this-replica window). The previous code
  // would write an outbound row with empty from/to/subject/body, which
  // (a) corrupts outbound counts, (b) consumes the unique providerMessageId
  // slot so the re-delivered notification with real data is silently
  // skipped as a duplicate, and (c) starves the customer-quote pipeline.
  // Returning early lets Microsoft Graph re-deliver the notification once
  // the message is fetchable; the resilient-fetch retries already handle
  // transient 5xx so a real "message vanished" returns null exactly once.
  if (!messageDetails || !fromEmail) {
    log(
      `Skipping notification with no fetchable message body: msgId=${providerMessageId} ` +
      `fromEmpty=${!fromEmail} detailsNull=${!messageDetails} ` +
      `resource="${resource.slice(0, 80)}"`,
    );
    return;
  }

  if (monitoredMailbox) {
    // Task #589 — POD intake routing. If this monitored mailbox is the org's
    // configured AR distro mailbox (e.g. getpaid@valuetruckaz.com), short-
    // circuit to the POD pipeline instead of the customer-mailbox path. The
    // POD pipeline owns its own classify → match → forward → persist flow.
    const podSettings = await storage
      .getPodIntakeSettings(orgId)
      .catch(() => undefined);
    if (
      podSettings?.enabled &&
      podSettings.monitoredMailboxId === monitoredMailbox.id
    ) {
      try {
        const { ingestPodEmail } = await import("../services/podIntakeService");
        const result = await ingestPodEmail({
          orgId,
          mailboxId: monitoredMailbox.id,
          mailboxAddress: monitoredMailbox.email,
          graphMessageId: providerMessageId,
          internetMessageId: messageDetails?.internetMessageId ?? null,
          receivedAt,
          fromEmail,
          fromName,
          subject,
          bodyText: bodyFull,
          bodyPreview,
        });
        log(
          `[pod-intake] msg=${providerMessageId} classification=${result.classification} status=${result.forwardStatus}`,
        );
      } catch (err) {
        log(
          `[pod-intake] error processing msg=${providerMessageId}: ${getErrorMessage(err)}`,
        );
      }
      return;
    }

    const allToRecipients = (messageDetails?.toRecipients ?? [])
      .map(r => r.emailAddress?.address)
      .filter((a): a is string => !!a);
    const ingestResult = await processUserMailboxEmail({
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
    // Task #867 / #874 — fan out a live-sync hint so any open Conversations
    // tab in this org invalidates its inbox feed within ~50ms instead of
    // waiting on the page's background refetch interval. Gated on `created`
    // so re-deliveries (Graph occasionally repeats notifications) do not
    // cause cache thrash. Best-effort: publish never throws.
    if (ingestResult.created) {
      publishLiveSync(
        orgId,
        ingestResult.direction === "outbound" ? "mailbox_outbound" : "mailbox_inbound",
        conversationId ?? undefined,
      );

      // Task #939 — event-driven email→quote pipeline. The moment an
      // inbound customer email is persisted by the webhook path, hand the
      // row off to the in-process classifier dispatcher. The dispatcher is
      // fire-and-forget (returns void synchronously, runs async under a
      // process-wide concurrency limiter + per-message wall clock) so the
      // webhook handler can still return 202 to Microsoft Graph in <1s.
      // Outbound rows skip this — quote ingestion only applies to inbound
      // customer mail. Backfill / admin manual-drain paths intentionally
      // do NOT call `dispatchInlineClassification`; their entry points are
      // checked by `tests/code-quality-guardrails.test.ts` Section 28.
      if (ingestResult.direction === "inbound" && ingestResult.messageId) {
        dispatchInlineClassification({ messageId: ingestResult.messageId });
      }
    }
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

  // Always write a row for every inbound webhook delivery — even when the
  // sender doesn't match a known carrier — so the LWQ Send & Reply Audit
  // panel can show "we received this reply but couldn't match it" rather
  // than dropping the evidence on the floor (Task #344).
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

  // Task #637 — when an inbound webhook delivery matches both a known
  // carrier and a recurring lane, bump reply_count on the (carrier, lane)
  // prior so the ranker reflects "this carrier responded to us on this
  // lane" on the next ranking pass. We deliberately do NOT classify here
  // (yes/loss/quote come from the LWQ classify-reply route or the PAFOE
  // classifier below). eventKey is keyed on providerMessageId so Graph
  // webhook re-deliveries of the exact same email cannot double-count.
  if (carrierMatch.carrierId && laneId && providerMessageId) {
    try {
      const lane = await storage.getRecurringLane(laneId);
      if (lane && lane.orgId === orgId) {
        const { laneSig } = await import("../laneCrossLinkService");
        const { recordCarrierLaneOutcome } = await import("../services/carrierLaneOutcomes");
        await recordCarrierLaneOutcome({
          orgId,
          carrierId: carrierMatch.carrierId,
          laneSignature: laneSig(lane.origin, lane.originState, lane.destination, lane.destinationState, lane.equipmentType),
          origin: lane.origin,
          originState: lane.originState,
          destination: lane.destination,
          destinationState: lane.destinationState,
          equipmentType: lane.equipmentType,
          event: "reply",
          eventKey: `lwq-webhook:${providerMessageId}:reply`,
        });
      }
    } catch (e) {
      log(`[carrier-lane-outcome] webhook reply bump error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (accountMatch) {
    // Use upsert (ON CONFLICT DO NOTHING on org_id, provider_message_id)
    // so retried Graph webhook deliveries can never create duplicate
    // email_messages rows.
    const { created } = await storage.upsertInboundEmailMessage({
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
    if (created) {
      log(`Customer inbound email_message created: from=${fromEmail} contact=${accountMatch.contactName} company=${accountMatch.companyId} msgId=${providerMessageId}`);
    }
  }

  // Task #302 — Play outcome auto-tagging. Runs even when account didn't
  // match (e.g. bounce DSN from mailer-daemon@) because the play_run is
  // keyed by Outlook conversationId, not by sender identity.
  if (conversationId) {
    try {
      const { classifyAndPersistInboundReply } = await import("../services/playOutcomeClassifierService");
      await classifyAndPersistInboundReply({
        orgId, conversationId, fromEmail, subject, bodyFull, providerMessageId,
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      log(`[play-outcome] classify error: ${errMsg}`);
      recordIntegrationEvent({
        source: "graph",
        outcome: "error",
        errorMessage: `play_outcome_classify:${providerMessageId}: ${errMsg.slice(0, 200)}`,
      });
    }
  }

  // PAFOE Phase 4 — match inbound replies back to a freight_opportunity_carriers
  // row by Outlook thread/message ID and record a structured outcome + signal.
  try {
    const { classifyOpportunityReply } = await import("../freightOpportunityOutreachService");
    const { storage } = await import("../storage");
    await classifyOpportunityReply(storage, {
      orgId,
      conversationId: conversationId ?? null,
      internetMessageId: providerMessageId,
      fromEmail,
      subject,
      bodyFull,
      providerMessageId,
      emailMessageId: null,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    log(`[pafoe-classify] error: ${errMsg}`);
    recordIntegrationEvent({
      source: "graph",
      outcome: "error",
      errorMessage: `pafoe_classify:${providerMessageId}: ${errMsg.slice(0, 200)}`,
    });
  }

  if (carrierMatch.confidence === "unmatched" && !accountMatch) {
    log(`Unmatched inbound email: from=${fromEmail} msgId=${providerMessageId} — no carrier or CRM contact found`);
  }
}

// NOTE: This monitored-mailbox path handles all mail flowing through a rep's
// own Outlook mailbox (CRM contacts, accounts, etc.) and writes to
// `email_messages` / `email_conversation_threads`. It is intentionally NOT
// mirrored into `carrier_outreach_logs` — that table is reserved for the
// LWQ/procurement carrier-outreach lane flow (shared reply mailbox path).
// The LWQ Send & Reply Audit panel (Task #344) reads `carrier_outreach_logs`
// and surfaces per-rep mailbox health from `monitored_mailboxes` separately.
/**
 * Task #874 — return shape for the shared user-mailbox ingest helper. Callers
 * use `created` to decide whether to publish a `mailbox_inbound` /
 * `mailbox_outbound` live-sync hint (we only want to fire once per row, not
 * once per call — re-syncs of an existing row should stay quiet so the
 * Conversations page doesn't refetch on every webhook + poll race).
 *
 * `direction` is always populated, even on early drops, so callers can pick
 * the right topic without re-running the from-address comparison.
 */
export interface UserMailboxIngestResult {
  created: boolean;
  direction: "inbound" | "outbound";
  /** Internal `email_messages.id` for the persisted row. Populated only
   *  when `created === true` so callers (Task #939 inline classifier
   *  dispatch site below + the polling delta-sync equivalent) can hand
   *  the freshly-persisted row off to the in-process classification
   *  pipeline without re-querying. Undefined on the early-drop / dedupe
   *  paths to keep "no row written, no follow-up work" obvious. */
  messageId?: string;
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
  // Task #517 — which ingestion path produced this row. Used by the
  // admin coverage UI to confirm the historical 30-day backfill is
  // actually firing through this same code path. Defaults to "delta"
  // (live webhook / delta sync) so existing callers don't change.
  ingestedVia?: "delta" | "backfill" | "self_heal";
}): Promise<UserMailboxIngestResult> {
  const {
    orgId, monitoredMailbox, fromEmail, fromName, toEmail, allToRecipients, subject,
    bodyPreview, bodyFull, conversationId, providerMessageId, receivedAt, mailboxEmail,
  } = params;
  const ingestedVia = params.ingestedVia ?? "delta";

  const isFromMailboxOwner = fromEmail.toLowerCase() === mailboxEmail.toLowerCase();
  const direction = isFromMailboxOwner ? "outbound" : "inbound";

  // Task #1002 — unified TOMBSTONE-DROP. A Graph delivery is "tombstoned" if
  // it's unfetchable in either of the two ways the May-2026 incident surfaced:
  //
  //   (a) Empty payload: !fromEmail && !subject && !bodyFull. Graph @removed
  //       placeholders look like this — persisting creates skinny rows that
  //       pollute the inbox without giving operators anything to act on.
  //
  //   (b) Empty from + empty mailbox owner: !fromEmail && !mailboxEmail. This
  //       is the exact `"" === ""` mis-classification that fabricated junk
  //       outbound rows during the incident. processNotification + delta-sync
  //       now block this upstream, but other callers (backfill, self-heal)
  //       still reuse this helper, so the defensive layer stays.
  //
  // Hoisted above the unknown-first-touch / accountMatch logic so it applies
  // to known AND unknown senders — an empty Graph notification is useless
  // regardless of who the supposed sender is. This is the only allowed
  // `created: false` early-return alongside the duplicate-skip below; the
  // Section-30 guardrail in tests/code-quality-guardrails.test.ts pins that
  // contract.
  const isEmptyPayload = !fromEmail && !subject && !bodyFull;
  const isMailboxEmpty = !fromEmail && !mailboxEmail;
  if (isEmptyPayload || isMailboxEmpty) {
    const reason = isMailboxEmpty
      ? "empty from + empty mailbox owner — would fabricate outbound from \"\" === \"\""
      : "no from / no subject / no body — Graph @removed placeholder";
    log(
      `[user-mailbox] TOMBSTONE-DROP direction=inbound msgId=${providerMessageId} ` +
        `ingestedVia=${ingestedVia} (${reason})`,
    );
    return { created: false, direction };
  }

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
  // Task #1056 (Email→Exec 5) — Track HOW we hard-attached the message so
  // the post-persist hook can stamp the right `attribution_inference_source`
  // on the thread (and so we never re-run free-mail Tier 2/3 inference on
  // top of an already strong attribution). Stays null when no hard attach
  // happened — the free-mail recovery service then decides between
  // 'signature' / 'weak' / no-stamp.
  let hardAttachedSource:
    | "contact"
    | "thread"
    | "domain"
    | null = null;
  for (const email of counterpartyEmails) {
    accountMatch = await matchInboundSenderToAccount(email, orgId);
    if (accountMatch) {
      hardAttachedSource = "contact";
      break;
    }
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
    hardAttachedSource = "thread";
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
        hardAttachedSource = "domain";
        log(`[user-mailbox] Domain-match fallback linked email from ${email} → company ${matchedCompanyId}`);
        break;
      }
    }
  }

  // Task #751 — also try matching the counterparty against a known carrier
  // (using the strengthened sender→carrier matcher with domain fallback).
  // This is the user-mailbox equivalent of the shared-inbox carrier match
  // and is required so that carrier intel signals flow from rep mailboxes,
  // not just the shared-inbox path. Picks the first unambiguous match
  // across the counterparty list.
  let carrierMatch: { carrierId: string; confidence: string } | null = null;
  for (const email of counterpartyEmails) {
    const cm = await matchInboundCarrier(email, orgId, storage);
    if (cm.carrierId && cm.confidence !== "ambiguous") {
      carrierMatch = { carrierId: cm.carrierId, confidence: cm.confidence };
      log(`[user-mailbox] Carrier match (${cm.confidence}) ${email} → carrier ${cm.carrierId}`);
      break;
    }
  }

  // Carry an existing thread's linkedCarrierId forward when we have no
  // fresh carrier match — preserves thread continuity (mirrors the
  // existingThreadAccountId fallback above).
  let existingThreadCarrierId: string | null = null;
  if (conversationId && existingThreadExists) {
    const existingThreadEarly = await storage.getEmailConversationThreadByThreadId(orgId, conversationId);
    existingThreadCarrierId = existingThreadEarly?.linkedCarrierId ?? null;
  }
  const effectiveCarrierId = carrierMatch?.carrierId ?? existingThreadCarrierId;

  // P0 incident fix — DROP-GATE removed (was: silent early-return for inbound
  // emails when sender wasn't a known contact, wasn't a known carrier, and
  // didn't extend an existing thread). That gate destroyed brand-new
  // customer first-touch quote emails because they look identical to noise:
  // the sender has never emailed this org before, so contact + carrier +
  // thread lookups all miss. Production logs showed thousands of these
  // dropped per day with `fromEmpty=false subjEmpty=false` — i.e. real
  // routable emails being thrown away.
  //
  // Replacement contract (per the user directive on this incident):
  //   - PRESERVE: persist the row via the upsert below, with linkedAccountId
  //     and linkedCarrierId both null. The downstream upsert + thread create
  //     are already null-safe.
  //   - SCOPE: linkedAccountId IS NULL keeps these rows out of the rep's
  //     "Customers" inbox tab (storage.ts:8736 filters on
  //     linkedAccountId IS NOT NULL), so this change does not pollute the
  //     existing rep view; the rows are visible to admin diagnostics + the
  //     existing inline classifier so unknown-sender quote requests can
  //     still be auto-extracted.
  //   - LOG: emit a distinct `PERSIST-UNKNOWN` line so ops can count first-
  //     touch traffic and so this branch is grep-attributable.
  //
  // EXCEPTION (Task #302, retained): outbound rep emails must always reach
  // the play-run stamping block below so we can attribute the send to a
  // play run via tier-3 (unbound recent run) matching, even when the
  // recipient doesn't match a CRM contact and no thread exists yet. The
  // `direction !== "outbound"` predicate below preserves that bypass.
  //
  // The single guard we keep is for true Outlook tombstones — a Graph
  // delivery with no from / no subject / no body is a `@removed` placeholder
  // (or an empty-payload race), not a real email. Persisting those would
  // create skinny rows that pollute the inbox without giving operators
  // anything to act on. Skinny-row prevention proper is owned by a separate
  // task; this is the minimum guard needed to make the DROP-GATE removal
  // safe.
  const isUnknownFirstTouch =
    !accountMatch && !effectiveCarrierId && !existingThreadExists && direction !== "outbound";
  if (isUnknownFirstTouch) {
    // Empty-payload tombstones are already filtered by the unified
    // TOMBSTONE-DROP check above, so by the time we reach here the row is
    // worth preserving even though no contact / carrier / thread matched.
    log(
      `[user-mailbox] PERSIST-UNKNOWN direction=inbound from=${fromEmail || "(empty)"} ` +
        `subjEmpty=${!subject} bodyEmpty=${!bodyFull} msgId=${providerMessageId} — ` +
        `preserving as unknown first-touch (linkedAccountId=null, linkedCarrierId=null)`,
    );
  }

  // NOTE: we used to drop the message here when the matched account was
  // assigned to a different rep than the one whose mailbox received the
  // email. That silently lost real customer correspondence whenever a
  // rep was on a thread for an account they didn't formally own. The
  // conversations tab is org-scoped, so persist the message and let
  // `determineInitialOwner` (downstream) assign the thread to the
  // correct rep — typically the assignedTo on the company.

  const { message, created } = await storage.upsertInboundEmailMessage({
    orgId,
    providerMessageId,
    threadId: conversationId,
    direction,
    fromEmail,
    toEmail,
    subject,
    body: bodyFull.slice(0, 8000),
    linkedAccountId: accountMatch?.companyId ?? null,
    linkedCarrierId: effectiveCarrierId,
    linkedLaneId: null,
    linkedLoadId: null,
    linkedTaskId: null,
    linkedNbaId: null,
    linkedOutreachLogId: null,
    processedForSignalsAt: null,
    // Task #435: persist provider sentDateTime so timeline ordering /
    // display reflects when the message was actually sent (matters for
    // self-heal recoveries that may run hours after the fact).
    providerSentAt: receivedAt,
    // Task #517 — record ingestion path for coverage diagnostics.
    ingestedVia,
  });

  if (!created) {
    log(`[user-mailbox] Duplicate email skipped: msgId=${providerMessageId}`);
    return { created: false, direction };
  }

  log(`[user-mailbox] ${direction} email recorded: from=${fromEmail} to=${toEmail} account=${accountMatch?.companyId ?? "(none)"} msgId=${providerMessageId}`);

  // Task #1055 (Email→Exec 4) — Signature-derived contact + rep link sweep.
  // Run after the inbound row is persisted whenever we have a known
  // company, REGARDLESS of whether the sender already matches a CRM
  // contact. The sweep itself decides what to do:
  //   - sender unknown            → create or suggest
  //   - existing contact is thin  → enrich null fields only (never
  //                                 overwrite filled fields, so a
  //                                 "complete" contact short-circuits to
  //                                 noop_existing_complete inside the
  //                                 sweep)
  //   - existing contact complete → noop_existing_complete (cheap
  //                                 lookup, no writes)
  // Gating only on `!accountMatch.contactId` here would have skipped the
  // "sender mapped to placeholder contact (just an email + null title)"
  // case, which is one of the most common shapes the parser is meant
  // to fix. The sweep is org-scoped by construction (`companyId` is the
  // org-resolved match above) and best-effort: failures NEVER break
  // ingestion.
  if (
    direction === "inbound" &&
    accountMatch?.companyId
  ) {
    try {
      const { sweepSignatureContactForInbound } = await import(
        "../services/signatureContactSweep"
      );
      const sweepResult = await sweepSignatureContactForInbound(message, storage, {
        companyId: accountMatch.companyId,
      });
      if (sweepResult.action !== "skipped_no_signal" && sweepResult.action !== "noop_existing_complete") {
        log(
          `[user-mailbox] signature-sweep action=${sweepResult.action}` +
            (sweepResult.contactId ? ` contact=${sweepResult.contactId}` : "") +
            ` company=${accountMatch.companyId}`,
        );
      }
    } catch (sweepErr) {
      log(
        `[user-mailbox] signature-sweep error: ${sweepErr instanceof Error ? sweepErr.message : String(sweepErr)}`,
      );
    }
  }

  // Task #867 / #874 — live-sync hint is now emitted by each caller (webhook,
  // delta-sync poll, reply-capture self-heal) using the `created` signal in
  // the returned result. Centralising it here would have made the polling-
  // fallback path silently inherit the publish, but a future refactor of this
  // helper could just as silently take it away — the per-caller emit makes the
  // contract auditable in `tests/code-quality-guardrails.test.ts`.

  // Task #534 — record a thread-events row for outbound emails sent from
  // the rep's monitored mailbox (typically composed in Outlook). This is
  // the "human_sent" audit signal in the Smarter Conversations detail
  // pane. Best-effort: failures must never break ingestion.
  if (direction === "outbound" && conversationId) {
    try {
      const { recordThreadEvent } = await import("../services/conversationThreadEventsService");
      const ownerName = (await storage.getUser(monitoredMailbox.userId).catch(() => null))?.name ?? null;
      await recordThreadEvent({
        orgId,
        threadId: conversationId,
        eventType: "human_sent",
        description: `Email sent from ${mailboxEmail}`,
        actorUserId: monitoredMailbox.userId,
        actorName: ownerName,
        details: {
          providerMessageId,
          to: toEmail,
          subject,
          ingestedVia,
        },
      });
    } catch (e) {
      log(`[user-mailbox] thread-event human_sent log failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (conversationId) {
    try {
      const { applyMessageToThread } = await import("../services/conversationWaitingStateService");
      const { determineInitialOwner } = await import("../services/conversationOwnershipService");

      const existingThread = await storage.getEmailConversationThreadByThreadId(orgId, conversationId);
      const now = new Date();

      const threadBase: EmailConversationThread = existingThread ?? {
        id: "", orgId, threadId: conversationId,
        linkedAccountId: accountMatch?.companyId ?? null, linkedCarrierId: effectiveCarrierId,
        ownerUserId: monitoredMailbox.userId,
        waitingState: "waiting_on_us",
        responsePriority: "normal", lastMessageId: null,
        lastIncomingAt: null, lastOutgoingAt: null, lastEmailAt: null,
        waitingSinceAt: null, overdueAt: null,
        archivedAt: null,
        snoozedUntil: null, snoozedFromState: null, snoozedByUserId: null,
        createdAt: now, updatedAt: now, rowVersionAt: now,
        attributionInferenceSource: null, attributionEvidence: null,
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
        linkedAccountId: accountMatch?.companyId ?? null,
        linkedCarrierId: effectiveCarrierId,
        update: { ...update, ownerUserId },
      });

      log(`[user-mailbox] Conversation thread upserted: threadId=${conversationId} owner=${ownerUserId}`);

      // Task #1056 (Email→Exec 5) — Free-mail attribution recovery.
      // Hard-attach paths (contact / domain / thread continuity) just get
      // an `attribution_inference_source` stamp so the UI can render the
      // "Inferred from: …" badge. For inbound free-mail senders that
      // missed every hard-attach (`hardAttachedSource === null`), the
      // service runs Tier 2 (signature company match) and Tier 3 (weak
      // display-name match) and persists a `confirm_account_attribution`
      // suggestion on the thread — never a hard attach. The
      // PERSIST-UNKNOWN row above stays unlinked until the rep confirms.
      // Best-effort: failures NEVER break ingestion.
      if (direction === "inbound") {
        try {
          const { applyFreeMailAttribution } = await import(
            "../services/freeMailAttributionService"
          );
          const refreshedThread = await storage.getEmailConversationThreadByThreadId(
            orgId,
            conversationId,
          );
          await applyFreeMailAttribution({
            orgId,
            threadId: conversationId,
            fromEmail,
            fromName: fromName ?? null,
            subject,
            body: bodyFull,
            hardAttachedSource,
            existingThread: refreshedThread ?? null,
          });
        } catch (attrErr) {
          log(
            `[user-mailbox] free-mail attribution error: ${attrErr instanceof Error ? attrErr.message : String(attrErr)}`,
          );
        }
      }
    } catch (convErr) {
      log(`[user-mailbox] Conversation upsert error: ${convErr instanceof Error ? convErr.message : String(convErr)}`);
    }
  }

  // Task #302 — auto-tag play outcomes from inbound replies on monitored
  // mailboxes (this is the primary delivery path for customer email).
  if (direction === "inbound" && conversationId) {
    try {
      const { classifyAndPersistInboundReply } = await import("../services/playOutcomeClassifierService");
      await classifyAndPersistInboundReply({
        orgId, conversationId, fromEmail, subject, bodyFull,
        providerMessageId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`[user-mailbox] play-outcome classify error: ${msg}`);
      // Surface this swallow on the Integrations Health console so an
      // outage in the play-outcome classifier doesn't go invisible.
      // Tag suffix `_user_mailbox` keeps it distinct from the
      // shared-mailbox classifier emit above.
      recordIntegrationEvent({
        source: "graph",
        outcome: "error",
        errorMessage: `play_outcome_classify_user_mailbox:${providerMessageId ?? "unknown"}: ${msg}`,
      });
    }
    // PAFOE Phase 4 freight-opportunity classifier (parallel to play-outcome)
    try {
      const { classifyOpportunityReply } = await import("../freightOpportunityOutreachService");
      await classifyOpportunityReply(storage, {
        orgId,
        conversationId,
        internetMessageId: providerMessageId,
        fromEmail,
        subject,
        bodyFull,
        providerMessageId,
        emailMessageId: null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`[user-mailbox] pafoe-classify error: ${msg}`);
      // Same rationale as the play-outcome emit above — the PAFOE
      // freight-opportunity classifier silently failing was previously
      // invisible outside the raw log.
      recordIntegrationEvent({
        source: "graph",
        outcome: "error",
        errorMessage: `pafoe_classify_user_mailbox:${providerMessageId ?? "unknown"}: ${msg}`,
      });
    }
  }

  // Outbound capture: when the rep sends a play email from their monitored
  // mailbox, link the play_run to this Graph conversationId + messageId so
  // future inbound replies can be matched.
  //
  // Match priority (most → least specific) so attribution is deterministic
  // even when account matching fails:
  //   1. open run owned by this rep, account-matched to the recipient's
  //      company, started in the last 24h
  //   2. open run owned by this rep, contact-matched on contact email,
  //      started in the last 24h
  //   3. open run owned by this rep with NO account binding yet, started
  //      in the last 6h (guard against hijacking older work)
  // Whichever matches first gets stamped; we never stamp more than one run
  // per outbound send.
  if (direction === "outbound" && conversationId) {
    try {
      const { db } = await import("../storage");
      const { sql: sqlTag } = await import("drizzle-orm");
      const recipientEmail = (counterpartyEmails[0] ?? "").toLowerCase();
      await db.execute(sqlTag`
        UPDATE play_runs r
        SET thread_id = ${conversationId},
            provider_message_id = ${providerMessageId},
            sent_at = NOW()
        WHERE r.id = (
          SELECT r2.id FROM play_runs r2
          JOIN plays p ON p.id = r2.play_id
          LEFT JOIN contacts c ON c.id = r2.contact_id AND c.deleted_at IS NULL
          WHERE r2.org_id = ${orgId}
            AND r2.rep_user_id = ${monitoredMailbox.userId}
            AND r2.status IN ('open', 'suggested')
            AND r2.thread_id IS NULL
            AND p.channel = 'email'
            AND (
              -- Tier 1: account-matched + 24h
              (${accountMatch?.companyId ?? null}::varchar IS NOT NULL
                 AND r2.account_id = ${accountMatch?.companyId ?? null}
                 AND COALESCE(r2.started_at, r2.suggested_at) > NOW() - INTERVAL '24 hours')
              -- Tier 2: contact-email matched + 24h
              OR (${recipientEmail}::text <> ''
                  AND LOWER(c.email) = ${recipientEmail}
                  AND COALESCE(r2.started_at, r2.suggested_at) > NOW() - INTERVAL '24 hours')
              -- Tier 3: rep's only unbound recent run + 6h
              OR (r2.account_id IS NULL
                  AND COALESCE(r2.started_at, r2.suggested_at) > NOW() - INTERVAL '6 hours')
            )
          ORDER BY
            -- Prefer account-matched, then contact-matched, then unbound
            (CASE WHEN r2.account_id = ${accountMatch?.companyId ?? null} THEN 0
                  WHEN LOWER(c.email) = ${recipientEmail} THEN 1
                  ELSE 2 END),
            COALESCE(r2.started_at, r2.suggested_at) DESC
          LIMIT 1
        )
      `);
      // Seed the pending play_outcome row so the window-expiry sweep and the
      // inbound classifier both have something to update.
      await db.execute(sqlTag`
        INSERT INTO play_outcomes (play_run_id, outcome, status, window_expires_at)
        SELECT r.id, 'no_response', 'pending',
               NOW() + (p.outcome_window_hours::int * INTERVAL '1 hour')
        FROM play_runs r
        JOIN plays p ON p.id = r.play_id
        WHERE r.thread_id = ${conversationId}
          AND r.org_id = ${orgId}
        ON CONFLICT (play_run_id) DO NOTHING
      `);
    } catch (e) {
      log(`[user-mailbox] play-run send-link error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Task #803 — Quote Lifecycle Autopilot (B). When a rep sends an
  // outbound reply on a thread that already has a pending quote
  // opportunity, AI-extract the offered rate. Confident extraction
  // flips the quote to `quoted` with quotedAmount + validThrough +
  // quote_event(actor='auto:outbound_reply'). Uncertain extraction
  // drops a `note` event onto the timeline. Idempotent on
  // providerMessageId; best-effort + non-fatal.
  if (direction === "outbound" && conversationId) {
    try {
      const { applyOutboundReplyToOpenQuote } = await import(
        "../services/outboundQuoteAutoQuote"
      );
      const result = await applyOutboundReplyToOpenQuote(message);
      if (result.status === "quoted" || result.status === "noted") {
        log(
          `[user-mailbox] quote-autopilot ${result.status} oppId=${result.quoteId} ` +
            `${result.quotedAmount ? `amount=$${result.quotedAmount}` : ""}`,
        );
      }
    } catch (e) {
      log(
        `[user-mailbox] quote-autopilot outbound error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Task #435: track outbound capture so the SentItems health classifier
  // counts ANY successful capture path (webhook OR delta OR self-heal).
  await storage.updateMonitoredMailbox(monitoredMailbox.id, {
    lastSyncAt: new Date(),
    ...(direction === "outbound" && created ? { lastOutboundCapturedAt: new Date() } : {}),
  });

  // Task #874 — `created` is true here (we returned early above otherwise).
  // Callers gate their `mailbox_inbound` / `mailbox_outbound` publish on
  // this exact `created` flag so the polling-fallback path emits live-sync
  // hints with the same idempotency guarantees as the webhook path.
  // Task #939 — also surface `messageId` so callers can dispatch the new
  // inline classifier for inbound rows without an extra DB lookup.
  return { created: true, direction, messageId: message.id };
}

export { processUserMailboxEmail as processUserMailboxEmailForDelta };

export async function processGraphNotifications(body: unknown): Promise<void> {
  // Task #549 — webhook clientState is a hard requirement. Without it we
  // cannot tell forged notifications from real ones, so the only safe
  // behavior is to drop the entire batch and log loudly. The legacy
  // `GRAPH_WEBHOOK_CLIENT_STATE` fallback is intentionally removed so
  // there is exactly one secret env var across the whole pipeline.
  const expectedClientState = (process.env.OUTLOOK_WEBHOOK_SECRET ?? "").trim();
  const payload = body as GraphNotificationPayload | null | undefined;
  const notifications = payload?.value;
  if (!Array.isArray(notifications) || notifications.length === 0) {
    return;
  }

  if (!expectedClientState) {
    log(`Refusing to process ${notifications.length} Graph notification(s) — OUTLOOK_WEBHOOK_SECRET is not set. Configure the secret to enable email ingestion.`);
    return;
  }

  for (const notification of notifications) {
    if (notification.clientState !== expectedClientState) {
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
        // Task #435: track SentItems webhook delivery so admins can see in
        // the monitored-mailboxes screen whether the SentItems sub is
        // actually firing for each rep — the most common silent failure
        // mode for "rep replied but it didn't show up".
        // Task #867: also track Inbox webhook delivery so the watchdog can
        // classify each subscription independently (Inbox can be silent
        // while SentItems is healthy, and vice versa).
        const now = new Date();
        if (monitoredMb.sentItemsSubscriptionId === notification.subscriptionId) {
          await storage.updateMonitoredMailbox(monitoredMb.id, {
            lastSentItemsNotificationAt: now,
          }).catch(() => {});
        } else if (monitoredMb.subscriptionId === notification.subscriptionId) {
          await storage.updateMonitoredMailbox(monitoredMb.id, {
            lastInboxNotificationAt: now,
          }).catch(() => {});
        }
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
      log(`processNotification error: ${getErrorMessage(err)}`);
    });
  }
}

export function registerGraphWebhookRoutes(app: Express): void {
  app.get("/api/webhooks/graph/email", (req: Request, res: Response) => {
    const validationToken = qOptStr(req.query.validationToken);
    if (validationToken) {
      res.set("Content-Type", "text/plain");
      return res.status(200).send(validationToken);
    }
    return res.status(200).json({ ok: true });
  });
}
