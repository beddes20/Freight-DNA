/**
 * Conversation Thread Summary Service (Task #534)
 *
 * Generates and caches a short AI summary (2–3 lines: who, what they want,
 * where it stands, last activity) for a conversation thread. Backs the
 * summary card at the top of the right-hand detail pane on the
 * Conversations page.
 *
 * Caching strategy: a stable contentHash is computed over the ordered list
 * of (messageId, providerSentAt) for every message in the thread. When a
 * new message arrives, the live hash drifts from the stored hash and the
 * next read auto-regenerates. A `force` flag also lets the rep regenerate
 * on demand from the UI.
 */

import crypto from "crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../storage";
import {
  conversationThreadSummaries,
  emailMessages,
  type ConversationThreadSummary,
  type EmailMessage,
} from "@shared/schema";
import { getAgentOpenAI, AGENT_MODELS } from "../agent/openai";

export interface ThreadSummaryResult {
  summary: string;
  generatedAt: string;
  messageCount: number;
  lastMessageAt: string | null;
  cached: boolean;
  stale: boolean;
  contentHash: string;
}

const MAX_MESSAGES_FOR_SUMMARY = 12;
const MAX_BODY_CHARS_PER_MESSAGE = 1200;

function stripHtml(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function computeContentHash(messages: Pick<EmailMessage, "id" | "providerSentAt" | "createdAt">[]): string {
  const h = crypto.createHash("sha1");
  for (const m of messages) {
    const ts = m.providerSentAt ?? m.createdAt;
    h.update(m.id);
    h.update("|");
    h.update(ts ? new Date(ts).toISOString() : "0");
    h.update("\n");
  }
  return h.digest("hex");
}

async function loadThreadMessages(orgId: string, threadId: string): Promise<EmailMessage[]> {
  return db.select()
    .from(emailMessages)
    .where(and(
      eq(emailMessages.orgId, orgId),
      eq(emailMessages.threadId, threadId),
    ))
    .orderBy(asc(sql`COALESCE(${emailMessages.providerSentAt}, ${emailMessages.createdAt})`));
}

function buildPrompt(messages: EmailMessage[]): string {
  // Keep the most recent N messages — we still want enough context to
  // understand the ask, but we shouldn't burn tokens summarising 6-month
  // chains.
  const slice = messages.slice(-MAX_MESSAGES_FOR_SUMMARY);
  const transcript = slice.map(m => {
    const dir = m.direction === "outbound" ? "WE SENT" : "THEY SENT";
    const ts = (m.providerSentAt ?? m.createdAt) ? new Date(m.providerSentAt ?? m.createdAt).toISOString() : "";
    const from = m.fromEmail ?? "(unknown)";
    const subj = m.subject ?? "(no subject)";
    const body = stripHtml(m.body).slice(0, MAX_BODY_CHARS_PER_MESSAGE);
    return `[${dir} ${ts}]\nFrom: ${from}\nSubject: ${subj}\n${body}`;
  }).join("\n---\n");

  return `You are summarising an email thread for a freight broker rep so they can decide what to do next without re-reading the chain. Write 2–3 short sentences that cover, in plain English:
  • who the other party is and what they want;
  • where the conversation stands right now (waiting on us, waiting on them, resolved);
  • what the most recent activity was.

Do not invent details. Do not use bullet points or headers. No greetings.

Email thread (oldest → newest):
${transcript}`;
}

async function callSummaryModel(prompt: string): Promise<string> {
  const openai = getAgentOpenAI();
  const resp = await openai.chat.completions.create({
    model: AGENT_MODELS.fast,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 220,
    temperature: 0.3,
  }, { signal: AbortSignal.timeout(20_000) });
  return resp.choices[0]?.message?.content?.trim() ?? "";
}

/**
 * Read the cached summary for a thread without computing or generating.
 * Returns null if no row exists. Used by the suggestion service so it can
 * piggy-back on the rep's recent summary view.
 */
export async function getCachedSummary(orgId: string, threadId: string): Promise<ConversationThreadSummary | null> {
  const [row] = await db.select()
    .from(conversationThreadSummaries)
    .where(and(
      eq(conversationThreadSummaries.orgId, orgId),
      eq(conversationThreadSummaries.threadId, threadId),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * Get the cached summary for a thread, or generate one if the cache is
 * empty / stale (or `force` is true). Returns null when the thread has no
 * messages stored locally yet (nothing to summarise).
 */
export async function getOrGenerateThreadSummary(opts: {
  orgId: string;
  threadId: string;
  force?: boolean;
}): Promise<ThreadSummaryResult | null> {
  const { orgId, threadId, force = false } = opts;

  const messages = await loadThreadMessages(orgId, threadId);
  if (messages.length === 0) return null;

  const liveHash = computeContentHash(messages);
  const lastMessage = messages[messages.length - 1];
  const lastMessageAt = (lastMessage.providerSentAt ?? lastMessage.createdAt) ?? null;

  const cached = await getCachedSummary(orgId, threadId);
  const cacheValid = cached && cached.contentHash === liveHash && !force;

  if (cacheValid && cached) {
    return {
      summary: cached.summary,
      generatedAt: cached.generatedAt.toISOString(),
      messageCount: cached.messageCount,
      lastMessageAt: cached.lastMessageAt ? cached.lastMessageAt.toISOString() : null,
      cached: true,
      stale: false,
      contentHash: cached.contentHash,
    };
  }

  const prompt = buildPrompt(messages);
  let summary = "";
  try {
    summary = await callSummaryModel(prompt);
  } catch (err) {
    console.error("[thread-summary] generation failed:", err);
    // If generation fails but we have a stale cached row, surface it so
    // the rep still sees something useful (with a `stale` flag the UI
    // can use to nudge a regenerate).
    if (cached) {
      return {
        summary: cached.summary,
        generatedAt: cached.generatedAt.toISOString(),
        messageCount: cached.messageCount,
        lastMessageAt: cached.lastMessageAt ? cached.lastMessageAt.toISOString() : null,
        cached: true,
        stale: true,
        contentHash: cached.contentHash,
      };
    }
    throw err;
  }

  if (!summary) {
    if (cached) {
      return {
        summary: cached.summary,
        generatedAt: cached.generatedAt.toISOString(),
        messageCount: cached.messageCount,
        lastMessageAt: cached.lastMessageAt ? cached.lastMessageAt.toISOString() : null,
        cached: true,
        stale: true,
        contentHash: cached.contentHash,
      };
    }
    throw new Error("AI returned an empty summary");
  }

  // Upsert the row keyed by (orgId, threadId).
  const generatedAt = new Date();
  const upsertValues = {
    orgId,
    threadId,
    summary,
    contentHash: liveHash,
    messageCount: messages.length,
    lastMessageAt: lastMessageAt ? new Date(lastMessageAt) : null,
    model: AGENT_MODELS.fast,
    generatedAt,
  };
  await db.insert(conversationThreadSummaries)
    .values(upsertValues)
    .onConflictDoUpdate({
      target: [conversationThreadSummaries.orgId, conversationThreadSummaries.threadId],
      set: {
        summary,
        contentHash: liveHash,
        messageCount: messages.length,
        lastMessageAt: lastMessageAt ? new Date(lastMessageAt) : null,
        model: AGENT_MODELS.fast,
        generatedAt,
      },
    });

  return {
    summary,
    generatedAt: generatedAt.toISOString(),
    messageCount: messages.length,
    lastMessageAt: lastMessageAt ? new Date(lastMessageAt).toISOString() : null,
    cached: false,
    stale: false,
    contentHash: liveHash,
  };
}

/** Compute the live content hash for a thread (used by the suggestion service). */
export async function computeThreadContentHash(orgId: string, threadId: string): Promise<{
  hash: string;
  messageCount: number;
  lastMessage: EmailMessage | null;
}> {
  const messages = await loadThreadMessages(orgId, threadId);
  return {
    hash: computeContentHash(messages),
    messageCount: messages.length,
    lastMessage: messages.length > 0 ? messages[messages.length - 1] : null,
  };
}

export const __testing = { computeContentHash, stripHtml };
