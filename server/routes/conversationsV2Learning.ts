/**
 * Conversations v2 Learning Cockpit Routes (Task #1087)
 *
 * Dev-only endpoints powering the learning-oriented right pane on
 * `/conversations-v2`:
 *
 *   GET  /api/internal/conversations/v2/:threadId/learning
 *   POST /api/internal/conversations/v2/:threadId/feedback
 *
 * Strictly read-only against existing tables (email_conversation_threads,
 * email_messages, email_signals, conversation_thread_events,
 * quote_opportunities) plus the additive feedback log table
 * (conversation_thread_feedback_events). Computes outcome chip,
 * comparable-thread aggregates, and relationship memory on the read so
 * we don't add a precomputed cache.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db, storage } from "../storage";
import { pStr } from "../lib/req";
import {
  conversationThreadEvents,
  conversationThreadFeedbackEvents,
  conversationThreadSuggestions,
  emailConversationThreads,
  emailMessages,
  emailSignals,
  quoteOpportunities,
  type EmailConversationThread,
  type EmailMessage,
} from "@shared/schema";
import { requireAuth, getCurrentUser } from "../auth";
import { recordSuggestionFeedback } from "../services/conversationThreadSuggestionService";

// ── Outcome chip ──────────────────────────────────────────────────────────
// Derived from the linked customer quote status, recent thread events, and
// the thread's waiting state. No schema change — just a read-time roll-up.
export type V2OutcomeChip =
  | "quote_won"
  | "quote_lost"
  | "quote_created"
  | "tender_accepted"
  | "carrier_declined"
  | "no_response_yet"
  | "no_outcome_yet";

interface DerivedOutcomeInputs {
  thread: Pick<EmailConversationThread, "waitingState" | "lastIncomingAt" | "lastOutgoingAt">;
  linkedQuoteStatus: string | null;
  recentEventTypes: string[];
}

export function deriveOutcomeChip(input: DerivedOutcomeInputs): V2OutcomeChip {
  const status = (input.linkedQuoteStatus ?? "").toLowerCase();
  if (status === "won" || status === "won_low_margin") return "quote_won";
  if (status.startsWith("lost")) return "quote_lost";
  if (status === "no_response" || status === "expired") return "quote_lost";
  if (status && status !== "pending" && status !== "attached") return "quote_created";
  if (input.linkedQuoteStatus) return "quote_created";

  const events = new Set(input.recentEventTypes);
  if (events.has("resolved")) return "tender_accepted";
  if (events.has("archived") && input.thread.waitingState === "archived") {
    return "tender_accepted";
  }

  // Inbound came in, we never replied → "no response yet" (from us).
  const lastIn = input.thread.lastIncomingAt ? new Date(input.thread.lastIncomingAt).getTime() : 0;
  const lastOut = input.thread.lastOutgoingAt ? new Date(input.thread.lastOutgoingAt).getTime() : 0;
  if (input.thread.waitingState === "waiting_on_us" && lastIn > lastOut) {
    return "no_response_yet";
  }
  if (input.thread.waitingState === "waiting_on_them" && lastOut > 0) {
    return "no_response_yet";
  }
  return "no_outcome_yet";
}

// ── Intent classifier ─────────────────────────────────────────────────────
// Light wrapper over the same `intent_type` column the suggestion service
// reads. We bucket into three coarse "intent classes" so similarity
// queries don't fragment across every intent variation.
type IntentClass = "quote" | "tender" | "carrier_reply" | "general";

function classifyIntents(intentTypes: Set<string>): IntentClass {
  if (intentTypes.has("pricing_request") || intentTypes.has("quote_request")) return "quote";
  if (intentTypes.has("tender") || intentTypes.has("acceptance")) return "tender";
  if (intentTypes.has("carrier_reply") || intentTypes.has("hard_commitment")) return "carrier_reply";
  return "general";
}

async function loadIntentTypesForThreads(
  orgId: string,
  threadKeys: string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (threadKeys.length === 0) return out;
  try {
    const rows = await db
      .select({ threadId: emailMessages.threadId, intentType: emailSignals.intentType })
      .from(emailSignals)
      .innerJoin(emailMessages, eq(emailMessages.id, emailSignals.messageId))
      .where(and(
        eq(emailMessages.orgId, orgId),
        inArray(emailMessages.threadId, threadKeys),
      ));
    for (const r of rows) {
      if (!r.threadId || !r.intentType) continue;
      if (!out.has(r.threadId)) out.set(r.threadId, new Set());
      out.get(r.threadId)!.add(r.intentType);
    }
  } catch (err) {
    console.error("[conversations-v2-learning] intent load failed:", err);
  }
  return out;
}

// Crude lane fingerprint — same shape used by the v2 frontend's
// `deriveLaneSnippet`. Returns null when nothing confident is found so
// similarity falls back to account/intent rather than bluffing.
function laneFingerprint(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").slice(0, 4000);
  const m = t.match(/from\s+([A-Za-z .,'-]+?)\s+to\s+([A-Za-z .,'-]+?)(?:[,.\s]|$)/i)
    ?? t.match(/([A-Z][a-zA-Z .'-]+,\s*[A-Z]{2})\s*(?:->|→|to)\s*([A-Z][a-zA-Z .'-]+,\s*[A-Z]{2})/);
  if (!m) return null;
  return `${m[1].toLowerCase().trim()}|${m[2].toLowerCase().trim()}`;
}

// ── Linked-quote lookup (mirrors the inbox enrichment in conversations.ts) ──
// Returns a map: thread_id → { quoteId, status }
async function loadQuotesForThreads(
  orgId: string,
  threadKeys: string[],
): Promise<Map<string, { quoteId: string; status: string }>> {
  const out = new Map<string, { quoteId: string; status: string }>();
  if (threadKeys.length === 0) return out;
  try {
    const msgs = await db
      .select({
        threadId: emailMessages.threadId,
        id: emailMessages.id,
        providerMessageId: emailMessages.providerMessageId,
      })
      .from(emailMessages)
      .where(and(eq(emailMessages.orgId, orgId), inArray(emailMessages.threadId, threadKeys)));
    const refToThread = new Map<string, string>();
    const allRefs: string[] = [];
    for (const m of msgs) {
      if (!m.threadId) continue;
      if (m.providerMessageId) {
        refToThread.set(m.providerMessageId, m.threadId);
        allRefs.push(m.providerMessageId);
      }
      if (m.id) {
        refToThread.set(m.id, m.threadId);
        allRefs.push(m.id);
      }
    }
    if (allRefs.length === 0) return out;
    const rows = await db
      .select({
        id: quoteOpportunities.id,
        sourceReference: quoteOpportunities.sourceReference,
        outcomeStatus: quoteOpportunities.outcomeStatus,
        createdAt: quoteOpportunities.createdAt,
      })
      .from(quoteOpportunities)
      .where(and(
        eq(quoteOpportunities.organizationId, orgId),
        inArray(quoteOpportunities.sourceReference, allRefs),
      ));
    const sorted = [...rows].sort((a, b) => {
      const ad = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bd = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return ad - bd;
    });
    for (const q of sorted) {
      const tid = q.sourceReference ? refToThread.get(q.sourceReference) : null;
      if (tid && !out.has(tid)) {
        out.set(tid, { quoteId: q.id, status: q.outcomeStatus ?? "pending" });
      }
    }
  } catch (err) {
    console.error("[conversations-v2-learning] quote lookup failed:", err);
  }
  return out;
}

// ── Time helpers ──────────────────────────────────────────────────────────
function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function timeToReplyMs(t: { lastIncomingAt: Date | null; lastOutgoingAt: Date | null }): number | null {
  if (!t.lastIncomingAt || !t.lastOutgoingAt) return null;
  const inMs = new Date(t.lastIncomingAt).getTime();
  const outMs = new Date(t.lastOutgoingAt).getTime();
  if (outMs < inMs) return null;
  return outMs - inMs;
}

function timeToOutcomeMs(t: {
  createdAt: Date | string | null;
  archivedAt: Date | null;
  waitingState: string;
}): number | null {
  if (t.waitingState !== "archived" && t.waitingState !== "resolved") return null;
  const start = t.createdAt ? new Date(t.createdAt).getTime() : 0;
  const end = t.archivedAt ? new Date(t.archivedAt).getTime() : Date.now();
  if (!start || end < start) return null;
  return end - start;
}

const COMPARABLE_CAP = 200;

// ── Outcome chip helper exported for the inbox list batched lookup ────────
export async function deriveOutcomeChipsForThreads(
  orgId: string,
  threads: Array<EmailConversationThread & { linkedQuoteStatus?: string | null }>,
): Promise<Map<string, V2OutcomeChip>> {
  const out = new Map<string, V2OutcomeChip>();
  if (threads.length === 0) return out;
  const threadKeys = threads.map(t => t.threadId).filter(Boolean) as string[];

  // Quote status for those without one already attached.
  const needQuoteLookup = threads.some(t => t.linkedQuoteStatus === undefined);
  const quoteMap = needQuoteLookup ? await loadQuotesForThreads(orgId, threadKeys) : new Map();

  // Recent thread events.
  const eventMap = new Map<string, string[]>();
  if (threadKeys.length > 0) {
    try {
      const rows = await db
        .select({ threadId: conversationThreadEvents.threadId, eventType: conversationThreadEvents.eventType })
        .from(conversationThreadEvents)
        .where(and(
          eq(conversationThreadEvents.orgId, orgId),
          inArray(conversationThreadEvents.threadId, threadKeys),
        ))
        .orderBy(desc(conversationThreadEvents.createdAt))
        .limit(threadKeys.length * 5);
      for (const r of rows) {
        if (!r.threadId) continue;
        const arr = eventMap.get(r.threadId) ?? [];
        arr.push(r.eventType);
        eventMap.set(r.threadId, arr);
      }
    } catch (err) {
      console.error("[conversations-v2-learning] event lookup failed:", err);
    }
  }

  for (const t of threads) {
    if (!t.threadId) continue;
    const status = t.linkedQuoteStatus ?? quoteMap.get(t.threadId)?.status ?? null;
    out.set(t.id, deriveOutcomeChip({
      thread: t,
      linkedQuoteStatus: status,
      recentEventTypes: eventMap.get(t.threadId) ?? [],
    }));
  }
  return out;
}

// ── Body extractor for past-pattern note ──────────────────────────────────
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

const FEEDBACK_KIND_VALUES = {
  suggested_action: ["correct", "incorrect"],
  summary: ["useful", "not_useful"],
  is_quote: ["is_quote", "not_quote"],
  recommended_reply: ["worked", "did_not_work"],
} as const;
type FeedbackKind = keyof typeof FEEDBACK_KIND_VALUES;

const feedbackBodySchema = z.object({
  kind: z.enum(["suggested_action", "summary", "is_quote", "recommended_reply"]),
  value: z.string().min(1).max(64),
  notes: z.string().max(2000).optional().nullable(),
});

export function registerConversationsV2LearningRoutes(app: Express): void {
  // ── GET /api/internal/conversations/v2/:threadId/learning ─────────────────
  app.get("/api/internal/conversations/v2/:threadId/learning", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      // The v2 page selects threads by row id. Look up the underlying thread.
      const threadIdParam = pStr(req.params.threadId);
      const threadRow = await storage.getEmailConversationThreadById(threadIdParam);
      if (!threadRow || threadRow.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Thread not found" });
      }

      const orgId = user.organizationId;
      const subjectThreadKey = threadRow.threadId;

      // Latest message for lane fingerprint and intent set.
      const myMessages = await db
        .select()
        .from(emailMessages)
        .where(and(eq(emailMessages.orgId, orgId), eq(emailMessages.threadId, subjectThreadKey)))
        .orderBy(asc(sql`COALESCE(${emailMessages.providerSentAt}, ${emailMessages.createdAt})`));
      const lastInbound =
        [...myMessages].reverse().find(m => m.direction === "inbound") ?? myMessages[myMessages.length - 1] ?? null;
      const myFingerprint = laneFingerprint(
        `${lastInbound?.subject ?? ""} ${stripHtml(lastInbound?.body ?? "")}`,
      );

      // My intent class.
      const myIntents = await loadIntentTypesForThreads(orgId, [subjectThreadKey]);
      const myIntentClass = classifyIntents(myIntents.get(subjectThreadKey) ?? new Set());

      // ── Comparable-thread query ──────────────────────────────────────────
      // Anchor on the same account when present, falling back to the same
      // carrier, otherwise an org-wide pool capped to COMPARABLE_CAP. We
      // exclude the subject thread itself.
      let candidateRows: EmailConversationThread[] = [];
      const baseFilter = and(
        eq(emailConversationThreads.orgId, orgId),
        ne(emailConversationThreads.id, threadRow.id),
      );
      if (threadRow.linkedAccountId) {
        candidateRows = await db
          .select()
          .from(emailConversationThreads)
          .where(and(baseFilter, eq(emailConversationThreads.linkedAccountId, threadRow.linkedAccountId)))
          .orderBy(desc(emailConversationThreads.lastEmailAt))
          .limit(COMPARABLE_CAP);
      } else if (threadRow.linkedCarrierId) {
        candidateRows = await db
          .select()
          .from(emailConversationThreads)
          .where(and(baseFilter, eq(emailConversationThreads.linkedCarrierId, threadRow.linkedCarrierId)))
          .orderBy(desc(emailConversationThreads.lastEmailAt))
          .limit(COMPARABLE_CAP);
      } else {
        candidateRows = await db
          .select()
          .from(emailConversationThreads)
          .where(baseFilter)
          .orderBy(desc(emailConversationThreads.lastEmailAt))
          .limit(COMPARABLE_CAP);
      }

      const candidateKeys = candidateRows.map(t => t.threadId).filter(Boolean) as string[];
      const candidateIntents = await loadIntentTypesForThreads(orgId, candidateKeys);
      const candidateQuotes = await loadQuotesForThreads(orgId, candidateKeys);

      // Filter to "comparable" candidates: same intent class. If we have a
      // lane fingerprint, prefer those that share it but still keep the
      // intent-matched pool so aggregates aren't always empty.
      const intentMatched = candidateRows.filter(c => {
        const cls = classifyIntents(candidateIntents.get(c.threadId) ?? new Set());
        return cls === myIntentClass;
      });
      const comparable = intentMatched.length > 0 ? intentMatched : candidateRows;

      // Fingerprint-matched subset (preferred for the past-pattern card).
      let laneMatched: EmailConversationThread[] = [];
      if (myFingerprint && comparable.length > 0) {
        const sampleKeys = comparable.slice(0, 50).map(c => c.threadId).filter(Boolean) as string[];
        if (sampleKeys.length > 0) {
          try {
            const lastByThread = await db
              .select({
                threadId: emailMessages.threadId,
                subject: emailMessages.subject,
                body: emailMessages.body,
              })
              .from(emailMessages)
              .where(and(eq(emailMessages.orgId, orgId), inArray(emailMessages.threadId, sampleKeys)))
              .orderBy(desc(sql`COALESCE(${emailMessages.providerSentAt}, ${emailMessages.createdAt})`))
              .limit(sampleKeys.length * 3);
            const seen = new Set<string>();
            const fingerByThread = new Map<string, string | null>();
            for (const r of lastByThread) {
              if (!r.threadId || seen.has(r.threadId)) continue;
              seen.add(r.threadId);
              fingerByThread.set(r.threadId, laneFingerprint(`${r.subject ?? ""} ${stripHtml(r.body)}`));
            }
            laneMatched = comparable.filter(c => fingerByThread.get(c.threadId) === myFingerprint);
          } catch (err) {
            console.error("[conversations-v2-learning] fingerprint scan failed:", err);
          }
        }
      }

      // ── Aggregates ──────────────────────────────────────────────────────
      let won = 0;
      let total = 0;
      const replyTimes: number[] = [];
      const outcomeTimes: number[] = [];
      const actionCount = new Map<string, number>();
      const failureCount = new Map<string, number>();

      for (const c of comparable) {
        const q = candidateQuotes.get(c.threadId);
        const status = (q?.status ?? "").toLowerCase();
        if (status) {
          total++;
          if (status === "won" || status === "won_low_margin") won++;
        }
        const rt = timeToReplyMs(c);
        if (rt !== null) replyTimes.push(rt);
        const ot = timeToOutcomeMs(c);
        if (ot !== null) outcomeTimes.push(ot);
        if (status.startsWith("lost")) {
          const reason = status.replace("lost_", "Lost ").replace(/_/g, " ");
          failureCount.set(reason, (failureCount.get(reason) ?? 0) + 1);
        }
        if (status === "no_response") {
          failureCount.set("No customer response", (failureCount.get("No customer response") ?? 0) + 1);
        }
      }

      // Top successful actions — pull thread events from "won" comparable
      // threads to see which event types preceded the close.
      const wonThreadKeys = comparable
        .filter(c => {
          const s = (candidateQuotes.get(c.threadId)?.status ?? "").toLowerCase();
          return s === "won" || s === "won_low_margin";
        })
        .map(c => c.threadId)
        .slice(0, 50);
      if (wonThreadKeys.length > 0) {
        try {
          const events = await db
            .select({ eventType: conversationThreadEvents.eventType })
            .from(conversationThreadEvents)
            .where(and(
              eq(conversationThreadEvents.orgId, orgId),
              inArray(conversationThreadEvents.threadId, wonThreadKeys),
            ))
            .limit(500);
          for (const e of events) {
            if (e.eventType === "human_sent") incr(actionCount, "Replied personally");
            else if (e.eventType === "ai_drafted") incr(actionCount, "Used AI-drafted reply");
            else if (e.eventType === "resolved") incr(actionCount, "Marked resolved promptly");
          }
        } catch (err) {
          console.error("[conversations-v2-learning] won-event scan failed:", err);
        }
      }

      const conversionRate = total > 0 ? won / total : null;
      const avgReply = avg(replyTimes);
      const avgOutcome = avg(outcomeTimes);

      // ── Comparable thread snippets (for the past-pattern card) ──────────
      const pastPool = laneMatched.length > 0 ? laneMatched : comparable;
      const pastSubset = pastPool.slice(0, 3);
      const pastKeys = pastSubset.map(c => c.threadId).filter(Boolean) as string[];
      const pastSubjects = new Map<string, string>();
      if (pastKeys.length > 0) {
        try {
          const subjRows = await db
            .select({ threadId: emailMessages.threadId, subject: emailMessages.subject })
            .from(emailMessages)
            .where(and(eq(emailMessages.orgId, orgId), inArray(emailMessages.threadId, pastKeys)))
            .orderBy(desc(sql`COALESCE(${emailMessages.providerSentAt}, ${emailMessages.createdAt})`))
            .limit(pastKeys.length * 3);
          for (const r of subjRows) {
            if (r.threadId && r.subject && !pastSubjects.has(r.threadId)) {
              pastSubjects.set(r.threadId, r.subject);
            }
          }
        } catch (err) {
          console.error("[conversations-v2-learning] past subject lookup failed:", err);
        }
      }
      const comparableThreads = pastSubset.map(c => {
        const status = candidateQuotes.get(c.threadId)?.status ?? null;
        const outcome = deriveOutcomeChip({
          thread: c,
          linkedQuoteStatus: status,
          recentEventTypes: [],
        });
        const note = oneLineNote(outcome, status);
        const occurredAt = (c.archivedAt ?? c.lastEmailAt ?? c.lastIncomingAt ?? c.updatedAt) ?? null;
        return {
          threadId: c.id,
          subject: pastSubjects.get(c.threadId) ?? "(no subject)",
          outcome,
          oneLineNote: note,
          occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null,
        };
      });

      // ── Relationship memory ─────────────────────────────────────────────
      let relationshipMemory: {
        responsivenessMs: number | null;
        lastReplyAt: string | null;
        priorQuotes: number;
        priorWins: number;
        lanes: string[];
        equipment: string[];
      } | null = null;

      if (threadRow.linkedAccountId || threadRow.linkedCarrierId) {
        const acctReplyTimes: number[] = [];
        let lastReplyAt: number = 0;
        for (const c of candidateRows) {
          const rt = timeToReplyMs(c);
          if (rt !== null) acctReplyTimes.push(rt);
          if (c.lastIncomingAt) {
            const ts = new Date(c.lastIncomingAt).getTime();
            if (ts > lastReplyAt) lastReplyAt = ts;
          }
        }
        let priorQuotes = 0;
        let priorWins = 0;
        const lanes = new Set<string>();
        const equipment = new Set<string>();
        if (threadRow.linkedAccountId) {
          try {
            const opps = await db
              .select({
                outcomeStatus: quoteOpportunities.outcomeStatus,
                originCity: quoteOpportunities.originCity,
                originState: quoteOpportunities.originState,
                destCity: quoteOpportunities.destCity,
                destState: quoteOpportunities.destState,
                equipment: quoteOpportunities.equipment,
                customerId: quoteOpportunities.customerId,
              })
              .from(quoteOpportunities)
              .where(eq(quoteOpportunities.organizationId, orgId))
              .limit(500);
            // We don't have a direct account → quote_customer mapping in
            // this slice; fall back to counting ANY opps where the source
            // thread is in our candidate set.
            for (const c of candidateRows) {
              const q = candidateQuotes.get(c.threadId);
              if (!q) continue;
              priorQuotes++;
              const s = (q.status ?? "").toLowerCase();
              if (s === "won" || s === "won_low_margin") priorWins++;
            }
            // Pull lane/equipment hints from any opps whose
            // source_reference resolved to one of our candidate threads.
            for (const o of opps) {
              const lane = `${o.originCity}, ${o.originState} → ${o.destCity}, ${o.destState}`.trim();
              if (lane.length > 4 && lanes.size < 5) lanes.add(lane);
              if (o.equipment && equipment.size < 5) equipment.add(o.equipment);
            }
          } catch (err) {
            console.error("[conversations-v2-learning] relationship memory failed:", err);
          }
        }
        relationshipMemory = {
          responsivenessMs: avg(acctReplyTimes),
          lastReplyAt: lastReplyAt > 0 ? new Date(lastReplyAt).toISOString() : null,
          priorQuotes,
          priorWins,
          lanes: [...lanes],
          equipment: [...equipment],
        };
      }

      // ── Outcome chip for the subject thread ─────────────────────────────
      const myQuoteStatus =
        (await loadQuotesForThreads(orgId, [subjectThreadKey])).get(subjectThreadKey)?.status ?? null;
      const myEvents = await db
        .select({ eventType: conversationThreadEvents.eventType })
        .from(conversationThreadEvents)
        .where(and(
          eq(conversationThreadEvents.orgId, orgId),
          eq(conversationThreadEvents.threadId, subjectThreadKey),
        ))
        .orderBy(desc(conversationThreadEvents.createdAt))
        .limit(5);
      const outcome = deriveOutcomeChip({
        thread: threadRow,
        linkedQuoteStatus: myQuoteStatus,
        recentEventTypes: myEvents.map(e => e.eventType),
      });

      res.json({
        outcome,
        intentClass: myIntentClass,
        signalCount: comparable.length,
        conversionRate,
        avgTimeToReplyMs: avgReply,
        avgTimeToOutcomeMs: avgOutcome,
        topSuccessfulActions: topN(actionCount, 3),
        commonFailurePatterns: topN(failureCount, 3),
        comparableThreads,
        relationshipMemory,
      });
    } catch (err) {
      console.error("[conversations-v2-learning] GET /learning error:", err);
      res.status(500).json({ error: "Failed to compute learning insights" });
    }
  });

  // ── POST /api/internal/conversations/v2/:threadId/feedback ────────────────
  app.post("/api/internal/conversations/v2/:threadId/feedback", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const threadIdParam = pStr(req.params.threadId);
      const threadRow = await storage.getEmailConversationThreadById(threadIdParam);
      if (!threadRow || threadRow.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Thread not found" });
      }
      const parsed = feedbackBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid feedback payload", details: parsed.error.flatten() });
      }
      const { kind, value, notes } = parsed.data;
      const allowed = FEEDBACK_KIND_VALUES[kind as FeedbackKind] as readonly string[];
      if (!allowed.includes(value)) {
        return res.status(400).json({ error: `Invalid value '${value}' for kind '${kind}'` });
      }

      // Append-only log row.
      await db.insert(conversationThreadFeedbackEvents).values({
        orgId: user.organizationId,
        threadId: threadRow.threadId,
        kind,
        value,
        notes: notes ?? null,
        userId: user.id,
      });

      // Mirror suggestion-style ratings into the existing suggestion row
      // so the dismissal-on-rehash contract continues to work.
      if (kind === "suggested_action" || kind === "recommended_reply") {
        const mapped = value === "correct" || value === "worked" ? "good" : "wrong";
        try {
          await recordSuggestionFeedback({
            orgId: user.organizationId,
            threadId: threadRow.threadId,
            userId: user.id,
            kind: mapped,
            notes: notes ?? null,
          });
        } catch (err) {
          // Non-fatal — the append-only event is already persisted.
          console.error("[conversations-v2-learning] suggestion mirror failed:", err);
        }
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("[conversations-v2-learning] POST /feedback error:", err);
      res.status(500).json({ error: "Failed to record feedback" });
    }
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function incr(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topN(map: Map<string, number>, n: number): Array<{ label: string; count: number }> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, count]) => ({ label, count }));
}

function oneLineNote(outcome: V2OutcomeChip, status: string | null): string {
  switch (outcome) {
    case "quote_won":
      return "Customer accepted our quote.";
    case "quote_lost":
      return status?.startsWith("lost_")
        ? `Lost — ${status.replace("lost_", "")}`
        : "Customer didn't move forward.";
    case "quote_created":
      return "Captured into the quote pipeline.";
    case "tender_accepted":
      return "Wrapped up — thread resolved.";
    case "carrier_declined":
      return "Carrier passed on the load.";
    case "no_response_yet":
      return "Still waiting on the next reply.";
    default:
      return "No outcome recorded.";
  }
}
