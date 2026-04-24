/**
 * Conversation Thread Suggestion Service (Task #534)
 *
 * Computes a one-click "next action" suggestion for a thread combining:
 *   - the thread's current waiting state and priority (deterministic
 *     signals already maintained by the waiting-state service);
 *   - any email_signals attached to messages in the thread (quote_request,
 *     pricing_request, urgent, etc.);
 *   - light AI reasoning over the latest message to produce a short
 *     human-readable reason and to refine the action choice when the
 *     deterministic rules are ambiguous.
 *
 * Cached per (orgId, threadId) keyed by the same contentHash the summary
 * service uses, so a new message invalidates the suggestion automatically.
 * Dismissals and "wrong suggestion" feedback are recorded on the cached
 * row so we can analyse accuracy without invalidating the cache. A
 * dismissal is itself a hash-scoped event — when a new message arrives the
 * dismissal is implicitly cleared (new hash → new row).
 */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../storage";
import {
  conversationThreadSuggestions,
  emailMessages,
  emailSignals,
  emailConversationThreads,
  type ConversationThreadSuggestion,
  type EmailMessage,
} from "@shared/schema";
import { getAgentOpenAI, AGENT_MODELS } from "../agent/openai";
import { computeThreadContentHash } from "./conversationThreadSummaryService";
import {
  getAccountFeedbackInsight,
  recordIncrementalFeedback,
  type AccountFeedbackInsight,
} from "./suggestionFeedbackLearningService";

export type SuggestionActionType =
  | "draft_reply"
  | "quote_request_reply"
  | "mark_resolved"
  | "await_response"
  | "none";

export interface ThreadSuggestion {
  actionType: SuggestionActionType;
  actionLabel: string;
  actionReason: string;
  actionParams: Record<string, unknown>;
  contentHash: string;
  generatedAt: string;
  cached: boolean;
  dismissed: boolean;
  feedbackKind: string | null;
}

const QUOTE_INTENT_TYPES = new Set(["pricing_request", "quote_request"]);
const URGENT_INTENT_TYPES = new Set(["urgent", "escalation"]);

function stripHtml(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

interface ThreadContext {
  thread: typeof emailConversationThreads.$inferSelect | null;
  messages: EmailMessage[];
  intentTypes: Set<string>;
}

async function loadContext(orgId: string, threadId: string): Promise<ThreadContext> {
  const [thread] = await db.select()
    .from(emailConversationThreads)
    .where(and(
      eq(emailConversationThreads.orgId, orgId),
      eq(emailConversationThreads.threadId, threadId),
    ))
    .limit(1);

  const messages = await db.select()
    .from(emailMessages)
    .where(and(
      eq(emailMessages.orgId, orgId),
      eq(emailMessages.threadId, threadId),
    ))
    .orderBy(asc(sql`COALESCE(${emailMessages.providerSentAt}, ${emailMessages.createdAt})`));

  const messageIds = messages.map(m => m.id);
  let intentTypes = new Set<string>();
  if (messageIds.length > 0) {
    const sigRows = await db.select({ intentType: emailSignals.intentType })
      .from(emailSignals)
      .where(inArray(emailSignals.messageId, messageIds));
    intentTypes = new Set(sigRows.map(r => r.intentType));
  }

  return { thread: thread ?? null, messages, intentTypes };
}

interface RuleResult {
  actionType: SuggestionActionType;
  actionLabel: string;
  actionReason: string;
  actionParams: Record<string, unknown>;
  /** Whether AI should refine the reason. */
  refineWithAI: boolean;
}

/**
 * Task #552: Pick a safer fallback when the rule-based suggestion has been
 * marked wrong for this account recently. The default fallback is
 * "draft_reply" because it never closes a thread or marks it waiting —
 * it just opens the compose window with no preset play type.
 */
function downgradeAction(base: RuleResult, ctx: ThreadContext): RuleResult {
  const lastInbound = [...ctx.messages].reverse().find(m => m.direction === "inbound") ?? ctx.messages[ctx.messages.length - 1];
  if (!lastInbound) {
    return {
      actionType: "none",
      actionLabel: "Nothing to do",
      actionReason: "This thread has no messages yet.",
      actionParams: {},
      refineWithAI: false,
    };
  }
  return {
    actionType: "draft_reply",
    actionLabel: "Draft reply",
    actionReason: "Falling back to a generic reply — past suggestions for this account were marked wrong.",
    actionParams: { targetMessageId: lastInbound.id },
    refineWithAI: true,
  };
}

/**
 * Deterministic action selection from existing signals + waiting state.
 * AI only refines the reason — it never picks a different action — so
 * suggestions stay predictable and the one-click handlers stay safe.
 */
function pickActionFromRules(ctx: ThreadContext): RuleResult {
  const { thread, messages, intentTypes } = ctx;
  const last = messages[messages.length - 1] ?? null;

  if (messages.length === 0 || !last) {
    return {
      actionType: "none",
      actionLabel: "Nothing to do",
      actionReason: "This thread has no messages yet.",
      actionParams: {},
      refineWithAI: false,
    };
  }

  const waitingState = thread?.waitingState ?? "waiting_on_us";

  if (waitingState === "archived") {
    return {
      actionType: "none",
      actionLabel: "Archived",
      actionReason: "This thread has been archived.",
      actionParams: {},
      refineWithAI: false,
    };
  }

  if (waitingState === "resolved") {
    return {
      actionType: "none",
      actionLabel: "Resolved",
      actionReason: "This thread is already marked resolved.",
      actionParams: {},
      refineWithAI: false,
    };
  }

  if (waitingState === "waiting_on_them") {
    return {
      actionType: "await_response",
      actionLabel: "No reply needed — waiting on them",
      actionReason: "We've already responded; the ball is in their court.",
      actionParams: {},
      refineWithAI: false,
    };
  }

  // waiting_on_us — pick a reply action based on the latest inbound message.
  const lastInbound = [...messages].reverse().find(m => m.direction === "inbound") ?? last;

  // Quote / pricing intent → bias the draft modal toward the carrier
  // capacity / pricing play type.
  if (intentTypes.has("pricing_request") || intentTypes.has("quote_request")) {
    return {
      actionType: "quote_request_reply",
      actionLabel: "Send quote",
      actionReason: "They asked for pricing — reply with a quote.",
      actionParams: {
        targetMessageId: lastInbound.id,
        playType: "carrier_capacity",
      },
      refineWithAI: true,
    };
  }

  if (intentTypes.has("urgent") || intentTypes.has("escalation")) {
    return {
      actionType: "draft_reply",
      actionLabel: "Reply now",
      actionReason: "They flagged this as urgent — respond ASAP.",
      actionParams: { targetMessageId: lastInbound.id },
      refineWithAI: true,
    };
  }

  return {
    actionType: "draft_reply",
    actionLabel: "Draft reply",
    actionReason: "They're waiting on a response from us.",
    actionParams: { targetMessageId: lastInbound.id },
    refineWithAI: true,
  };
}

interface AIRefinement {
  reason?: string;
  recommendation?: SuggestionActionType;
}

async function refineWithAI(
  ctx: ThreadContext,
  base: RuleResult,
  insight?: AccountFeedbackInsight | null,
): Promise<AIRefinement | null> {
  try {
    const last = ctx.messages[ctx.messages.length - 1];
    if (!last) return null;
    const lastInbound = [...ctx.messages].reverse().find(m => m.direction === "inbound") ?? last;
    const body = stripHtml(lastInbound.body).slice(0, 1500);
    const subject = lastInbound.subject ?? "(no subject)";
    const from = lastInbound.fromEmail ?? "(unknown)";

    // Task #552: Feed past rejected suggestions for this account into the
    // prompt so the model steers away from framings the rep already told
    // us were wrong. Capped to 5 short snippets to keep the prompt small.
    const avoidSection = insight && insight.recentWrongReasons.length > 0
      ? `\n\nThis account/org recently rejected suggestions phrased like:\n${insight.recentWrongReasons.map(r => `- "${r}"`).join("\n")}\nAvoid suggesting actions that fit the same framing — pick a different angle if those still apply.`
      : "";
    const downweightedSection = insight && insight.downweighted.size > 0
      ? `\n\nDo NOT recommend any of these action types for this account (rep already marked them wrong recently): ${[...insight.downweighted].join(", ")}.`
      : "";

    const prompt = `You are helping a freight broker rep decide what to do next on an email thread.

Latest inbound message:
From: ${from}
Subject: ${subject}
Body: ${body}

Existing thread state: ${ctx.thread?.waitingState ?? "waiting_on_us"} (priority ${ctx.thread?.responsePriority ?? "normal"})
Detected signals: ${[...ctx.intentTypes].join(", ") || "none"}

Our preliminary suggestion: ${base.actionLabel} — ${base.actionReason}${avoidSection}${downweightedSection}

Return STRICT JSON (no markdown, no commentary) with this shape:
{ "reason": "<one short plain-English sentence explaining what they want and why this action fits>",
  "recommendation": "draft_reply" | "quote_request_reply" | "mark_resolved" | "await_response" }

Rules:
- Keep "reason" under 160 characters, no greetings or fluff.
- Only set "recommendation" to "mark_resolved" if the latest message clearly indicates the conversation is done (e.g. "thanks, that's all I needed", "we're good", out-of-office auto-reply that doesn't require a follow-up).
- Only set "recommendation" to "await_response" if we have already addressed the latest message and are waiting on them.
- Default to "${base.actionType}" otherwise.`;

    const openai = getAgentOpenAI();
    const resp = await openai.chat.completions.create({
      model: AGENT_MODELS.fast,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      temperature: 0.2,
      response_format: { type: "json_object" },
    }, { signal: AbortSignal.timeout(15_000) });
    const raw = resp.choices[0]?.message?.content?.trim() ?? "";
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AIRefinement;
    return parsed;
  } catch (err) {
    console.error("[thread-suggestion] AI refinement failed:", err);
    return null;
  }
}

export async function getCachedSuggestion(orgId: string, threadId: string): Promise<ConversationThreadSuggestion | null> {
  const [row] = await db.select()
    .from(conversationThreadSuggestions)
    .where(and(
      eq(conversationThreadSuggestions.orgId, orgId),
      eq(conversationThreadSuggestions.threadId, threadId),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * Get the cached suggestion for a thread, regenerating when the contentHash
 * has drifted (new messages arrived since we last suggested). Returns null
 * if the thread has no messages yet.
 */
export async function getOrComputeThreadSuggestion(opts: {
  orgId: string;
  threadId: string;
  force?: boolean;
}): Promise<ThreadSuggestion | null> {
  const { orgId, threadId, force = false } = opts;
  const { hash: liveHash, messageCount } = await computeThreadContentHash(orgId, threadId);
  if (messageCount === 0) return null;

  const cached = await getCachedSuggestion(orgId, threadId);
  const cacheValid = cached && cached.contentHash === liveHash && !force;
  if (cacheValid && cached) {
    return {
      actionType: cached.actionType as SuggestionActionType,
      actionLabel: cached.actionLabel,
      actionReason: cached.actionReason,
      actionParams: (cached.actionParams as Record<string, unknown>) ?? {},
      contentHash: cached.contentHash,
      generatedAt: cached.generatedAt.toISOString(),
      cached: true,
      dismissed: !!cached.dismissedAt,
      feedbackKind: cached.feedbackKind,
    };
  }

  const ctx = await loadContext(orgId, threadId);
  const base = pickActionFromRules(ctx);

  // Task #552: Pull recent feedback for this account so we don't re-suggest
  // an action the rep already told us was wrong here. We always look this
  // up — when the thread isn't linked to a company we still get the
  // org-wide rollup, and when there's no relevant feedback both fields are
  // empty (cheap no-op).
  const insight = await getAccountFeedbackInsight({
    orgId,
    accountId: ctx.thread?.linkedAccountId ?? null,
  }).catch(err => {
    console.error("[thread-suggestion] feedback insight lookup failed:", err);
    return null;
  });

  let final: RuleResult = base;

  // If the rule-based pick lands on a downweighted action, fall back to a
  // safer default before we even ask the AI. This is what makes the
  // acceptance test ("a 'wrong' suggestion stops appearing for ~7 days")
  // hold even when AI refinement isn't run.
  if (insight && insight.downweighted.has(final.actionType)) {
    final = downgradeAction(final, ctx);
  }

  if (final.refineWithAI) {
    const refinement = await refineWithAI(ctx, final, insight);
    if (refinement) {
      const reason = (refinement.reason ?? "").trim();
      if (reason) final = { ...final, actionReason: reason };
      const allowed: SuggestionActionType[] = ["draft_reply", "quote_request_reply", "mark_resolved", "await_response"];
      if (refinement.recommendation && allowed.includes(refinement.recommendation)) {
        // If the AI tries to pick something the rep already rejected
        // recently for this account, ignore that recommendation and stick
        // with the (already-downgraded) base action.
        const aiPick = refinement.recommendation;
        const blocked = insight?.downweighted.has(aiPick) ?? false;
        if (!blocked) {
          if (aiPick === "mark_resolved") {
            final = {
              ...final,
              actionType: "mark_resolved",
              actionLabel: "Close out — no reply needed",
              actionParams: {},
            };
          } else if (aiPick === "await_response") {
            final = {
              ...final,
              actionType: "await_response",
              actionLabel: "Mark as waiting on them",
              actionParams: {},
            };
          } else if (aiPick !== final.actionType) {
            // The AI picked draft_reply / quote_request_reply explicitly —
            // honour it but keep our params (which carry targetMessageId).
            final = {
              ...final,
              actionType: aiPick,
              actionLabel: aiPick === "quote_request_reply" ? "Send quote" : "Draft reply",
            };
          }
        }
      }
    }
  }

  const generatedAt = new Date();
  await db.insert(conversationThreadSuggestions)
    .values({
      orgId,
      threadId,
      actionType: final.actionType,
      actionLabel: final.actionLabel,
      actionReason: final.actionReason,
      actionParams: final.actionParams,
      contentHash: liveHash,
      generatedAt,
      // New hash → clear any prior dismissal/feedback so the rep sees the
      // fresh suggestion in the UI.
      dismissedAt: null,
      dismissedByUserId: null,
      feedbackKind: null,
      feedbackNotes: null,
      feedbackAt: null,
      feedbackByUserId: null,
    })
    .onConflictDoUpdate({
      target: [conversationThreadSuggestions.orgId, conversationThreadSuggestions.threadId],
      set: {
        actionType: final.actionType,
        actionLabel: final.actionLabel,
        actionReason: final.actionReason,
        actionParams: final.actionParams,
        contentHash: liveHash,
        generatedAt,
        dismissedAt: null,
        dismissedByUserId: null,
        feedbackKind: null,
        feedbackNotes: null,
        feedbackAt: null,
        feedbackByUserId: null,
      },
    });

  return {
    actionType: final.actionType,
    actionLabel: final.actionLabel,
    actionReason: final.actionReason,
    actionParams: final.actionParams,
    contentHash: liveHash,
    generatedAt: generatedAt.toISOString(),
    cached: false,
    dismissed: false,
    feedbackKind: null,
  };
}

async function lookupAccountIdForThread(orgId: string, threadId: string): Promise<string | null> {
  const [t] = await db.select({ linkedAccountId: emailConversationThreads.linkedAccountId })
    .from(emailConversationThreads)
    .where(and(
      eq(emailConversationThreads.orgId, orgId),
      eq(emailConversationThreads.threadId, threadId),
    ))
    .limit(1);
  return t?.linkedAccountId ?? null;
}

export async function dismissSuggestion(opts: {
  orgId: string;
  threadId: string;
  userId: string;
}): Promise<boolean> {
  const cached = await getCachedSuggestion(opts.orgId, opts.threadId);
  if (!cached) return false;
  await db.update(conversationThreadSuggestions)
    .set({ dismissedAt: new Date(), dismissedByUserId: opts.userId })
    .where(eq(conversationThreadSuggestions.id, cached.id));

  // Task #552: feed the dismissal into the rolling stats so future
  // suggestions for the same account learn from it without waiting for
  // the nightly aggregate.
  try {
    const accountId = await lookupAccountIdForThread(opts.orgId, opts.threadId);
    await recordIncrementalFeedback({
      orgId: opts.orgId,
      accountId,
      actionType: cached.actionType,
      kind: "dismissed",
      reason: cached.actionReason,
    });
  } catch (err) {
    console.error("[thread-suggestion] incremental dismissal record failed:", err);
  }
  return true;
}

export async function recordSuggestionFeedback(opts: {
  orgId: string;
  threadId: string;
  userId: string;
  kind: "wrong" | "good";
  notes?: string | null;
}): Promise<boolean> {
  const cached = await getCachedSuggestion(opts.orgId, opts.threadId);
  if (!cached) return false;
  await db.update(conversationThreadSuggestions)
    .set({
      feedbackKind: opts.kind,
      feedbackNotes: opts.notes ?? null,
      feedbackAt: new Date(),
      feedbackByUserId: opts.userId,
      // A "wrong" rating implicitly hides the card too.
      dismissedAt: opts.kind === "wrong" ? new Date() : cached.dismissedAt,
      dismissedByUserId: opts.kind === "wrong" ? opts.userId : cached.dismissedByUserId,
    })
    .where(eq(conversationThreadSuggestions.id, cached.id));

  // Task #552: stream the rating into the learning stats so the next
  // suggestion request for this account already reflects it.
  try {
    const accountId = await lookupAccountIdForThread(opts.orgId, opts.threadId);
    await recordIncrementalFeedback({
      orgId: opts.orgId,
      accountId,
      actionType: cached.actionType,
      kind: opts.kind,
      reason: cached.actionReason,
    });
  } catch (err) {
    console.error("[thread-suggestion] incremental feedback record failed:", err);
  }
  return true;
}

// Re-exported for tests / future use elsewhere.
export const __internal = { pickActionFromRules };
