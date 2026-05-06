/**
 * Email Intelligence v1.5 — Tier 2.3 question register (Task #943).
 *
 * Detects explicit customer questions in inbound mail and writes them to
 * `email_questions`. Status flips to "answered" when a rep reply on the same
 * thread lands.
 */

import type { EmailMessage } from "@shared/schema";
import {
  upsertQuestion,
  getOpenQuestionsForThread,
  markQuestionAnswered,
  getProviderSentAtForMessages,
} from "./emailFactsStorage";

const INTERROGATIVE_LEADS = [
  /^can\s+you\b/i,
  /^could\s+you\b/i,
  /^would\s+you\b/i,
  /^will\s+you\b/i,
  /^do\s+you\b/i,
  /^does\s+(?:it|that|this|your)\b/i,
  /^did\s+you\b/i,
  /^is\s+(?:there|it|this|that|your)\b/i,
  /^are\s+(?:you|there|these|those)\b/i,
  /^was\s+(?:that|this|the)\b/i,
  /^were\s+(?:you|they|the)\b/i,
  /^have\s+you\b/i,
  /^has\s+(?:that|this|the)\b/i,
  /^how\s+(?:do|much|many|long|fast|soon)\b/i,
  /^what\s+(?:is|are|do|does|'s|time|day|happens)\b/i,
  /^when\s+(?:can|will|do|does|is|are|would)\b/i,
  /^where\s+(?:can|do|does|is|are)\b/i,
  /^who\s+(?:is|are|do|does|will|should)\b/i,
  /^why\s+(?:is|are|do|does|did|would)\b/i,
  /^which\s+\w+/i,
];

const SENTENCE_SPLIT = /(?<=[.?!])\s+(?=[A-Z])/;
const QUESTION_WORD_RE = /\b(can|could|would|will|do|does|did|is|are|was|were|have|has|how|what|when|where|who|why|which)\b/i;

function pruneQuoted(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*>/.test(l) && !/^On .{5,80}wrote:/.test(l))
    .join("\n");
}

function dedupeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export interface DetectedQuestion {
  questionText: string;
  confidence: number;
}

/**
 * Pure detector — segment the body into sentences and keep questions.
 */
export function detectQuestionsInInbound(body: string | null): DetectedQuestion[] {
  if (!body) return [];
  const cleaned = pruneQuoted(body);
  const out: DetectedQuestion[] = [];
  const seen = new Set<string>();
  for (const para of cleaned.split(/\n{2,}/)) {
    const sentences = para.split(SENTENCE_SPLIT);
    for (const raw of sentences) {
      const s = dedupeWhitespace(raw);
      if (s.length < 4 || s.length > 320) continue;
      const endsWithQ = s.endsWith("?");
      const startsWithLead = INTERROGATIVE_LEADS.some((re) => re.test(s));
      if (!endsWithQ && !startsWithLead) continue;
      const trimmed = s.replace(/^[^\w$]+/, "").replace(/\s+$/g, "");
      if (!trimmed) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      const confidence = endsWithQ && startsWithLead ? 90 : endsWithQ ? 75 : QUESTION_WORD_RE.test(trimmed) ? 60 : 40;
      out.push({ questionText: trimmed, confidence });
    }
  }
  return out;
}

/**
 * Live ingestion entry — detect + persist on inbound mail.
 */
export async function detectAndPersistQuestions(msg: EmailMessage): Promise<number> {
  if (msg.direction !== "inbound") return 0;
  const questions = detectQuestionsInInbound(msg.body);
  for (const q of questions) {
    await upsertQuestion({
      orgId: msg.orgId,
      messageId: msg.id,
      threadId: msg.threadId ?? null,
      linkedAccountId: msg.linkedAccountId ?? null,
      linkedContactId: null,
      askedByEmail: msg.fromEmail ?? null,
      questionText: q.questionText,
      status: "unanswered",
      confidence: q.confidence,
    });
  }
  return questions.length;
}

/**
 * On every outbound rep reply, mark all open questions on the thread as
 * "answered" with timeToAnswer derived from provider_sent_at.
 *
 * The asking-message timestamp lookup is performed inline against the same
 * `email_messages` table (scoped by org) so the caller no longer needs to
 * pre-load a thread message map. Tests can still inject one via
 * `originalMessageSentAtById` to skip the DB round-trip.
 */
export async function reconcileQuestionsOnRepReply(
  repReply: EmailMessage,
  originalMessageSentAtById?: Map<string, Date>,
): Promise<number> {
  if (!repReply.threadId) return 0;
  if (repReply.direction !== "outbound") return 0;
  const open = await getOpenQuestionsForThread(repReply.orgId, repReply.threadId);
  if (open.length === 0) return 0;

  // Resolve the missing askedAt timestamps from email_messages.
  let sentAtMap: Map<string, Date>;
  if (originalMessageSentAtById && originalMessageSentAtById.size > 0) {
    sentAtMap = originalMessageSentAtById;
  } else {
    const askingIds = Array.from(
      new Set(open.map((q) => q.messageId).filter((id) => id !== repReply.id)),
    );
    sentAtMap = await getProviderSentAtForMessages(repReply.orgId, askingIds);
  }

  const replyAt = repReply.providerSentAt ?? repReply.createdAt;
  let count = 0;
  for (const q of open) {
    if (q.messageId === repReply.id) continue;
    const askedAt = sentAtMap.get(q.messageId) ?? null;
    const ttaSec = askedAt ? Math.max(0, Math.floor((replyAt.getTime() - askedAt.getTime()) / 1000)) : null;
    await markQuestionAnswered(q.id, repReply.id, ttaSec);
    count += 1;
  }
  return count;
}
