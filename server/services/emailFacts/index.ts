/**
 * Email Intelligence v1.5 — Fact crystallization barrel + ingestion entry.
 *
 * `runEmailFactExtractors(msg, ctx)` is invoked from `processEmailMessage`
 * (server/emailIntelligenceService.ts) AFTER signals are persisted. Every
 * extractor is best-effort and isolated: a failure in one MUST NOT prevent
 * subsequent extractors from running, MUST NOT regress v1 signal extraction,
 * and MUST NOT block the response.
 */

import type { EmailMessage, EmailSignal } from "@shared/schema";
import { classifyAndPersistBounces } from "./bounceClassifier";
import { recordParticipantsForMessage } from "./participants";
import { classifyAndRouteAttachments, type AttachmentInput, type RateConRouterFn } from "./attachmentRouter";
import { extractAndPersistSlots } from "./slotExtractor";
import { detectAndPersistPromises, reconcilePromisesOnThreadReply } from "./promiseDetector";
import { detectAndPersistQuestions, reconcileQuestionsOnRepReply } from "./questionDetector";
import { gradeAndPersistOutbound } from "./outboundQualityGrader";
import { recordContactSentiment } from "./sentimentWriteback";

export { emailFactsAdapter, EmailFactsAdapter } from "./emailFactsAdapter";
export { isContactSuppressed } from "./bounceClassifier";
export { backfillEmailParticipants, getStakeholderGraphForAccount } from "./participants";
export { sweepOverduePromises } from "./promiseDetector";
export { getSentimentTrendForAccount } from "./sentimentWriteback";

export interface FactExtractorContext {
  attachments?: AttachmentInput[];
  rateConRouter?: RateConRouterFn;
  repUserId?: string | null;
  contactId?: string | null;
  /** Map of message_id → provider_sent_at (or createdAt) for question TTA. */
  threadMessageSentAtById?: Map<string, Date>;
  /** Raw Bcc header (Graph: bccRecipients) — surfaced to participant exploder. */
  bccEmail?: string | null;
  /** Raw Reply-To header (Graph: replyTo) — surfaced to participant exploder. */
  replyTo?: string | null;
}

export interface FactExtractorResult {
  bounces: number;
  participants: number;
  attachments: number;
  slots: number;
  forwardCalendar: number;
  competitiveSignals: number;
  promises: number;
  questions: number;
  promiseResolutions: number;
  questionResolutions: number;
  graded: boolean;
  sentimentRecorded: boolean;
  errors: Array<{ stage: string; message: string }>;
}

async function safe<T>(stage: string, fn: () => Promise<T>, errors: Array<{ stage: string; message: string }>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    errors.push({ stage, message: m });
    console.error(`[emailFacts] ${stage} error:`, m);
    return fallback;
  }
}

export async function runEmailFactExtractors(
  msg: EmailMessage,
  signals: EmailSignal[],
  ctx: FactExtractorContext = {},
): Promise<FactExtractorResult> {
  const errors: Array<{ stage: string; message: string }> = [];

  // Tier 1.2 — participants exploder runs first so other extractors can read.
  const participants = await safe(
    "participants",
    () => recordParticipantsForMessage(msg, { bccEmail: ctx.bccEmail ?? null, replyTo: ctx.replyTo ?? null }),
    errors,
    0,
  );

  // Tier 1.1 — bounce / DSN / OOO (inbound only).
  const bounces = await safe("bounce", () => classifyAndPersistBounces(msg), errors, 0);

  // Tier 1.3 — attachments router.
  const attachments = ctx.attachments && ctx.attachments.length > 0
    ? await safe("attachments", () => classifyAndRouteAttachments(msg, ctx.attachments!, { rateConRouter: ctx.rateConRouter }), errors, 0)
    : 0;

  // Tier 2.1 — slot extractor + forward calendar + competitive_signals.
  const slotResult = await safe(
    "slots",
    () => extractAndPersistSlots(msg),
    errors,
    { slots: 0, forwardCalendar: 0, competitiveSignals: 0 },
  );

  // Tier 2.2 / 2.3 — promise + question registers, plus reconciliations on
  // subsequent thread events.
  const promises = await safe("promises", () => detectAndPersistPromises(msg, ctx.repUserId), errors, 0);
  const promiseResolutions = msg.direction === "outbound"
    ? await safe("promiseReconcile", () => reconcilePromisesOnThreadReply(msg), errors, 0)
    : 0;
  const questions = await safe("questions", () => detectAndPersistQuestions(msg), errors, 0);
  const questionResolutions = msg.direction === "outbound"
    ? await safe(
        "questionReconcile",
        () => reconcileQuestionsOnRepReply(msg, ctx.threadMessageSentAtById),
        errors,
        0,
      )
    : 0;

  // Tier 2.4 — outbound quality grader (outbound only).
  let graded = false;
  if (msg.direction === "outbound") {
    const priorIntent = signals.find((s) => /objection|price_pushback|service_complaint/i.test(s.intentType))?.intentType ?? null;
    await safe(
      "qualityGrader",
      async () => {
        await gradeAndPersistOutbound(msg, { repUserId: ctx.repUserId ?? null, priorInboundIntent: priorIntent });
        graded = true;
      },
      errors,
      undefined,
    );
  }

  // Tier 2.5 — sentiment writeback (inbound + linked contact).
  let sentimentRecorded = false;
  if (msg.direction === "inbound" && ctx.contactId && msg.linkedAccountId) {
    await safe(
      "sentiment",
      async () => {
        const out = await recordContactSentiment(msg, { contactId: ctx.contactId });
        sentimentRecorded = !!out;
      },
      errors,
      undefined,
    );
  }

  return {
    bounces,
    participants,
    attachments,
    slots: slotResult.slots,
    forwardCalendar: slotResult.forwardCalendar,
    competitiveSignals: slotResult.competitiveSignals,
    promises,
    questions,
    promiseResolutions,
    questionResolutions,
    graded,
    sentimentRecorded,
    errors,
  };
}
