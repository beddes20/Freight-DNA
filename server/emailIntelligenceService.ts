/**
 * Email Intelligence Layer v1 (Task #190)
 *
 * Provides OpenAI-powered intent extraction for inbound/outbound email messages.
 * Supports typed carrier and customer intent taxonomies, deduplication, and
 * structured signal creation for downstream NBA engine integration.
 */

import { z } from "zod";
import { storage as defaultStorage, type IStorage } from "./storage";
import type {
  EmailMessage,
  EmailSignal,
  InsertEmailSignal,
  InsertEmailMessage,
} from "@shared/schema";
import { applyMessageToThread } from "./services/conversationWaitingStateService";
import { determineInitialOwner } from "./services/conversationOwnershipService";

// ─── Intent taxonomy ─────────────────────────────────────────────────────────

export const CARRIER_INTENTS = [
  "lane_offer",
  "lane_decline",
  "capacity_available",
  "capacity_unavailable",
  "new_lane_preference",
  "price_pushback",
  "service_issue",
  "soft_commitment",
  "hard_commitment",
  "paperwork_compliance",
] as const;

export const CUSTOMER_INTENTS = [
  "pricing_request",
  "objection",
  "service_complaint",
  "urgency_signal",
  "stalled_thread",
  "meaningful_touchpoint",
  "new_opportunity",
  "positive_feedback",
  "closed_won_indicator",
  "closed_lost_indicator",
  "conversation_spark_adhoc_to_structured",
  "conversation_spark_new_stakeholder",
  "conversation_spark_geography_expansion",
] as const;

export const ALL_INTENT_TYPES = [...CARRIER_INTENTS, ...CUSTOMER_INTENTS] as const;

// ─── Zod schema for OpenAI response ──────────────────────────────────────────

const ExtractedSignalSchema = z.object({
  intentType: z.enum(ALL_INTENT_TYPES),
  intentSubtype: z.string().nullable().optional(),
  confidence: z.number().int().min(0).max(100),
  extractedData: z.record(z.unknown()).optional().default({}),
  reasoning: z.string().optional(),
});

const ExtractionResponseSchema = z.object({
  signals: z.array(ExtractedSignalSchema),
  actorType: z.enum(["customer", "carrier", "internal"]),
  summary: z.string().optional(),
});

export type ExtractionResult = z.infer<typeof ExtractionResponseSchema>;
export type ExtractedSignal = z.infer<typeof ExtractedSignalSchema>;

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildSystemPrompt(direction: string): string {
  const actorNote = direction === "inbound"
    ? "The email was sent TO us FROM a carrier or customer."
    : "The email was sent BY us TO a carrier or customer.";

  return `You are an email intelligence analyst for a freight brokerage CRM.
${actorNote}

Your job is to extract structured signals from email content for CRM automation.

Return a JSON object with:
- "signals": array of intent signals detected in the email
- "actorType": "carrier", "customer", or "internal"
- "summary": a one-sentence summary of the email (optional)

Each signal must have:
- "intentType": one of the valid intent types listed below
- "intentSubtype": optional refinement string (e.g. "rate_too_low")
- "confidence": integer 0-100
- "extractedData": object with any relevant extracted values (rates, lanes, dates, etc.)
- "reasoning": brief explanation of why this intent was detected

CARRIER intent types (use when actorType is "carrier"):
- lane_offer: carrier is proactively offering capacity on a lane
- lane_decline: carrier is declining to cover a lane
- capacity_available: carrier has general capacity available
- capacity_unavailable: carrier has no available trucks
- new_lane_preference: carrier expressing interest in new lanes
- price_pushback: carrier pushing back on rate offered
- service_issue: carrier reporting a problem with a load or relationship
- soft_commitment: carrier indicating tentative willingness
- hard_commitment: carrier giving a firm yes or booking confirmation
- paperwork_compliance: carrier responding to compliance/docs request

CUSTOMER intent types (use when actorType is "customer"):
- pricing_request: customer asking for rates or quotes
- objection: customer raising a concern or pushback
- service_complaint: customer reporting a service problem
- urgency_signal: customer indicating time pressure
- stalled_thread: conversation appears stuck with no resolution
- meaningful_touchpoint: genuine engagement without a specific request
- new_opportunity: customer mentioning new lanes, volumes, or freight
- positive_feedback: customer expressing satisfaction
- closed_won_indicator: ANY language indicating the customer is awarding, dispatching,
  or moving forward with us on a load, lane, or bid. Be liberal here — operational
  follow-through is a win signal, not just explicit "you won" language.
  Examples that qualify (non-exhaustive):
    * "sending over the load now" / "sending you the rate con" / "rate con attached"
    * "tendering now" / "tender is on its way" / "I'll tender this to you"
    * "dispatching this to you" / "go ahead and cover" / "you're covered on this one"
    * "you got it" / "it's yours" / "consider this booked" / "booked with you"
    * "awarded" / "we're awarding you the lane" / "you won the bid"
    * "PO attached" / "load number is..." / "BOL attached" / "pickup is confirmed for..."
    * "approved at $X" / "we'll go with your rate" / "let's run it"
  Set extractedData.winLanguage to the exact phrase that triggered the signal.

- closed_lost_indicator: ANY language indicating the customer chose another carrier,
  no longer needs us on this load, or the opportunity is dead. Be liberal —
  customers very rarely send "you lost" language; the most common loss signal
  is "load is covered" type phrasing AFTER a quote was given.
  Examples that qualify (non-exhaustive):
    * "load is covered" / "we're covered" / "all set on this one" / "got it covered"
    * "no longer needed" / "we don't need it anymore" / "load cancelled"
    * "going in a different direction" / "we went with another carrier"
    * "appreciate the quote but..." / "thanks but we'll pass" / "not this time"
    * "rate is too high, going with someone else" / "we found cheaper coverage"
    * "we already have a carrier" / "moved this with another provider"
  IMPORTANT: a bare "covered" / "all set" reply on a thread that started with a
  pricing_request from us is almost always a loss — flag it with confidence ≥ 60
  even when the customer doesn't explicitly say they chose someone else.
  Set extractedData.lossLanguage to the exact phrase that triggered the signal.

CONVERSATION SPARK intent types (use when actorType is "customer"):
These capture data-backed outreach opportunities observed across email threads:
- conversation_spark_adhoc_to_structured: pattern of repeated ad hoc/spot loads on the same corridor suggests proposing a mini-bid or contracted lane (extractedData should include corridor, loadCount estimate)
- conversation_spark_new_stakeholder: a new person (not previously seen) is active on bids, quotes, or operational threads — suggests sending an intro (extractedData should include stakeholderName, role if visible)
- conversation_spark_geography_expansion: email threads reveal freight activity in a new geography or region not previously covered — suggests expanding coverage (extractedData should include region, corridor)

If no clear signal is present, return an empty signals array.
Return ONLY valid JSON.`;
}

/**
 * Strip email boilerplate before classification.
 *
 * Removes HTML tags, quoted history (lines starting with ">"), common email
 * signature markers ("--", "Sent from", "On ... wrote:", disclaimer blocks),
 * collapses whitespace, and truncates to a reasonable context window.
 */
export function stripEmailBoilerplate(raw: string): string {
  let text = raw;

  // 1. Strip HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // 2. Remove lines that are quoted reply history (start with ">")
  text = text
    .split("\n")
    .filter(line => !/^\s*>/.test(line))
    .join("\n");

  // 3. Remove common signature separators and everything after them
  // Covers: "--", "-- ", "___", "Sent from my", "On [date] ... wrote:"
  const sigBreaks = [
    /\n--\s*\n/,
    /\n_{3,}/,
    /\n-{3,}\n/,
    /\nSent from\b/i,
    /\nGet Outlook\b/i,
    /\nOn .{5,100}wrote:/,
    /\nFrom:\s*\S+@\S+/,
  ];
  for (const pattern of sigBreaks) {
    const idx = text.search(pattern);
    if (idx > 0) text = text.slice(0, idx);
  }

  // 4. Collapse blank lines and trim
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  // 5. Truncate to keep within token budget
  return text.slice(0, 1500);
}

function buildUserPrompt(msg: EmailMessage): string {
  const parts: string[] = [];
  if (msg.subject) parts.push(`Subject: ${msg.subject}`);
  if (msg.fromEmail) parts.push(`From: ${msg.fromEmail}`);
  if (msg.toEmail) parts.push(`To: ${msg.toEmail}`);
  parts.push(`Direction: ${msg.direction}`);
  if (msg.body) {
    const cleanedBody = stripEmailBoilerplate(msg.body);
    if (cleanedBody) parts.push(`\nBody:\n${cleanedBody}`);
  }
  return parts.join("\n");
}

// ─── OpenAI client factory ────────────────────────────────────────────────────

async function getOpenAiClient() {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });
}

// ─── Core extraction function ─────────────────────────────────────────────────

/**
 * Extract intent signals from an email message using OpenAI.
 * Returns an empty signals array on any extraction or parse failure — never throws.
 */
export async function extractEmailSignals(msg: EmailMessage): Promise<ExtractionResult> {
  try {
    const client = await getOpenAiClient();
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: buildSystemPrompt(msg.direction) },
        { role: "user", content: buildUserPrompt(msg) },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 1000,
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(`[emailIntelligence] OpenAI returned non-JSON for message ${msg.id}`);
      return { signals: [], actorType: "internal" };
    }

    const result = ExtractionResponseSchema.safeParse(parsed);
    if (!result.success) {
      console.error(`[emailIntelligence] Schema validation failed for message ${msg.id}:`, result.error.flatten());
      return { signals: [], actorType: "internal" };
    }
    return result.data;
  } catch (err) {
    console.error(`[emailIntelligence] extraction error for message ${msg.id}:`, err);
    return { signals: [], actorType: "internal" };
  }
}

// ─── Deduplication ────────────────────────────────────────────────────────────

export const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours (exported for tests)

export interface DeduplicateOptions {
  /**
   * How far back to look for duplicate signals (ms). Defaults to DEDUP_WINDOW_MS (24h).
   */
  windowMs?: number;
  /**
   * When true, bypass dedup entirely and return all signals unchanged.
   * Use for re-classification triggered by a force-override or support workflow.
   */
  force?: boolean;
  /**
   * Optional storage instance to inject for testability.
   */
  storageInstance?: Pick<IStorage, "getEmailSignalsByThread">;
}

export async function deduplicateSignals(
  newSignals: ExtractedSignal[],
  message: EmailMessage,
  options: DeduplicateOptions = {},
): Promise<ExtractedSignal[]> {
  if (newSignals.length === 0) return newSignals;

  // Force-override: skip all dedup checks
  if (options.force) return newSignals;

  // No threadId means we cannot look up history — return all signals
  if (!message.threadId) return newSignals;

  const windowMs = options.windowMs ?? DEDUP_WINDOW_MS;
  const storageInstance = options.storageInstance ?? defaultStorage;
  const since = new Date(Date.now() - windowMs);
  const existing = await storageInstance.getEmailSignalsByThread(message.threadId, since);

  if (existing.length === 0) return newSignals;

  // Suppress intents already seen within this thread in the dedup window
  const existingIntents = new Set(existing.map(s => s.intentType));
  return newSignals.filter(s => !existingIntents.has(s.intentType));
}

// ─── High-level process function ─────────────────────────────────────────────

export async function processEmailMessage(messageId: string): Promise<{
  message: EmailMessage;
  signals: EmailSignal[];
  skipped: boolean;
}> {
  const messages = await defaultStorage.getUnprocessedEmailMessages(1);
  const msg = messages.find(m => m.id === messageId);

  if (!msg) {
    throw new Error(`Email message ${messageId} not found or already processed`);
  }

  const result = await extractEmailSignals(msg);
  const deduped = await deduplicateSignals(result.signals, msg);

  const inserts: InsertEmailSignal[] = deduped.map(s => ({
    messageId: msg.id,
    intentType: s.intentType,
    intentSubtype: s.intentSubtype ?? null,
    actorType: result.actorType,
    entityType: msg.linkedCarrierId ? "carrier" : msg.linkedAccountId ? "account" : null,
    entityId: msg.linkedCarrierId ?? msg.linkedAccountId ?? null,
    confidence: s.confidence,
    extractedData: s.extractedData ?? {},
  }));

  const saved = inserts.length > 0 ? await defaultStorage.insertEmailSignals(inserts) : [];
  await defaultStorage.markEmailMessageProcessed(msg.id);

  return { message: msg, signals: saved, skipped: result.signals.length === 0 };
}

// ─── Log outbound carrier email (no LLM) ──────────────────────────────────────

export async function logOutboundCarrierEmail(params: {
  orgId: string;
  threadId?: string | null;
  fromEmail?: string | null;
  toEmail?: string | null;
  subject?: string | null;
  body?: string | null;
  linkedCarrierId?: string | null;
  linkedLaneId?: string | null;
  linkedOutreachLogId?: string | null;
  _storage?: Pick<IStorage, "insertEmailMessage" | "insertEmailSignals">;
}): Promise<{ message: EmailMessage; signal: EmailSignal | null }> {
  const storage = params._storage ?? defaultStorage;
  const message = await storage.insertEmailMessage({
    orgId: params.orgId,
    threadId: params.threadId ?? null,
    direction: "outbound",
    fromEmail: params.fromEmail ?? null,
    toEmail: params.toEmail ?? null,
    subject: params.subject ?? null,
    body: params.body ?? null,
    linkedCarrierId: params.linkedCarrierId ?? null,
    linkedLaneId: params.linkedLaneId ?? null,
    linkedOutreachLogId: params.linkedOutreachLogId ?? null,
    // Mark processed immediately since we insert the signal directly (no LLM needed)
    processedForSignalsAt: new Date(),
  });

  // Create a deterministic meaningful_touchpoint signal for outbound sends
  const [signal] = await storage.insertEmailSignals([{
    messageId: message.id,
    intentType: "meaningful_touchpoint",
    intentSubtype: "outbound_carrier_email",
    actorType: "internal",
    entityType: params.linkedCarrierId ? "carrier" : null,
    entityId: params.linkedCarrierId ?? null,
    confidence: 100,
    extractedData: {
      laneId: params.linkedLaneId ?? null,
      outreachLogId: params.linkedOutreachLogId ?? null,
    },
  }]);

  // ── Conversation thread upsert for outbound carrier emails ──────────────────
  if (params.threadId && params.linkedCarrierId && "upsertEmailConversationThread" in defaultStorage) {
    const convStorage = defaultStorage as any;
    try {
      const now = new Date();
      const existing = await convStorage.getEmailConversationThreadByThreadId(params.orgId, params.threadId);
      const threadBase = existing ?? {
        id: "", orgId: params.orgId, threadId: params.threadId,
        linkedAccountId: null, linkedCarrierId: params.linkedCarrierId,
        ownerUserId: null, waitingState: "waiting_on_them" as const,
        responsePriority: "normal" as const, lastMessageId: null,
        lastIncomingAt: null, lastOutgoingAt: null,
        waitingSinceAt: null, overdueAt: null, createdAt: now, updatedAt: now,
      };
      const update = applyMessageToThread(threadBase, message, now);
      let ownerUserId = existing?.ownerUserId ?? null;
      if (!existing) {
        ownerUserId = await determineInitialOwner(message, params.orgId, convStorage).catch(() => null);
      }
      await convStorage.upsertEmailConversationThread({
        orgId: params.orgId,
        threadId: params.threadId,
        linkedCarrierId: params.linkedCarrierId,
        linkedAccountId: null,
        update: { ...update, ownerUserId: ownerUserId ?? undefined },
      });
    } catch (convErr) {
      console.error("[emailIntelligenceService] logOutboundCarrierEmail conversation upsert error:", convErr);
    }
  }

  return { message, signal: signal ?? null };
}

// ─── Log inbound carrier reply (queued for LLM extraction) ────────────────────

export async function logInboundCarrierEmail(params: {
  orgId: string;
  /**
   * Provider-level message ID (e.g. Graph internetMessageId). When supplied,
   * the function performs an upsert instead of a blind insert so that replayed
   * Graph webhook notifications don't create duplicate email_messages rows.
   */
  providerMessageId?: string | null;
  threadId?: string | null;
  fromEmail?: string | null;
  toEmail?: string | null;
  subject?: string | null;
  body?: string | null;
  linkedCarrierId?: string | null;
  linkedLaneId?: string | null;
  linkedOutreachLogId?: string | null;
}): Promise<{ message: EmailMessage; created: boolean }> {
  return defaultStorage.upsertInboundEmailMessage({
    orgId: params.orgId,
    providerMessageId: params.providerMessageId ?? null,
    threadId: params.threadId ?? null,
    direction: "inbound",
    fromEmail: params.fromEmail ?? null,
    toEmail: params.toEmail ?? null,
    subject: params.subject ?? null,
    body: params.body ?? null,
    linkedCarrierId: params.linkedCarrierId ?? null,
    linkedLaneId: params.linkedLaneId ?? null,
    linkedOutreachLogId: params.linkedOutreachLogId ?? null,
    // Leave processedForSignalsAt null — background processor will handle it
    processedForSignalsAt: null,
  });
}
