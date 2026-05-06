/**
 * Suggestion Feedback Learning Service (Task #552)
 *
 * Closes the loop on the conversation thread suggestion card. Reps already
 * rate suggestions (dismiss, "wrong suggestion", "good"), but until now
 * nothing consumed those signals. This service:
 *
 *   1. Aggregates recent feedback from `conversation_thread_suggestions`
 *      into a small per-(org, account, action_type) summary table
 *      (`conversation_suggestion_feedback_stats`). Runs nightly via
 *      `suggestionFeedbackLearningScheduler` and on-demand whenever a rep
 *      submits new feedback.
 *   2. Exposes `getDownweightedActionsForAccount()` so the suggestion
 *      service can avoid re-recommending an action a rep already marked
 *      wrong for the same account in the last 7 days.
 *   3. Exposes `getRecentWrongExamples()` so the AI refinement prompt can
 *      include a few "avoid suggestions like these for this account"
 *      examples without bloating the prompt.
 *
 * Keyed by accountId (the linked company on the thread). Threads without a
 * linked account collapse to the `__org__` sentinel so they still get an
 * org-wide rollup that can shape future suggestions.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../storage";
import {
  conversationSuggestionFeedbackStats,
  conversationThreadSuggestions,
  emailConversationThreads,
  type ConversationSuggestionFeedbackStats,
} from "@shared/schema";
import type { SuggestionActionType } from "./conversationThreadSuggestionService";

export const ORG_WIDE_ACCOUNT_SENTINEL = "__org__";
const DEFAULT_LOOKBACK_DAYS = 14;
const DOWNWEIGHT_WINDOW_DAYS = 7;
const MAX_REASON_SAMPLES = 5;
const MAX_REASON_LEN = 200;

function logMessage(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${t} [suggestion-feedback-learning] ${message}`);
}

interface FeedbackRow {
  orgId: string;
  accountId: string;
  actionType: string;
  feedbackKind: string | null;
  dismissedAt: Date | null;
  feedbackAt: Date | null;
  actionReason: string;
}

function pickEffectiveAt(row: { feedbackAt: Date | null; dismissedAt: Date | null }): Date | null {
  return row.feedbackAt ?? row.dismissedAt ?? null;
}

/**
 * Recompute the rolling stats table from the last `lookbackDays` of
 * conversation_thread_suggestions feedback. Designed to be safe to run
 * concurrently with normal suggestion writes — we upsert per
 * (orgId, accountId, actionType) row and zero out keys that no longer have
 * any qualifying feedback so stale stats decay automatically.
 */
export async function aggregateSuggestionFeedback(opts?: { lookbackDays?: number }): Promise<{
  scanned: number;
  keysUpdated: number;
  keysCleared: number;
}> {
  const lookbackDays = opts?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  // Pull every suggestion in the window that received any kind of feedback
  // (rated good/wrong, or explicitly dismissed). We left-join the thread
  // row so we can resolve the linked account; threads without one fall
  // back to the org-wide sentinel so org-level patterns still surface.
  const rows = await db.select({
    orgId: conversationThreadSuggestions.orgId,
    accountId: emailConversationThreads.linkedAccountId,
    actionType: conversationThreadSuggestions.actionType,
    actionReason: conversationThreadSuggestions.actionReason,
    feedbackKind: conversationThreadSuggestions.feedbackKind,
    feedbackAt: conversationThreadSuggestions.feedbackAt,
    dismissedAt: conversationThreadSuggestions.dismissedAt,
  })
  .from(conversationThreadSuggestions)
  .leftJoin(
    emailConversationThreads,
    and(
      eq(emailConversationThreads.orgId, conversationThreadSuggestions.orgId),
      eq(emailConversationThreads.threadId, conversationThreadSuggestions.threadId),
    ),
  )
  .where(
    and(
      // At least one of feedbackAt / dismissedAt is recent enough to count.
      sql`(
        (${conversationThreadSuggestions.feedbackAt} IS NOT NULL AND ${conversationThreadSuggestions.feedbackAt} >= ${cutoff})
        OR
        (${conversationThreadSuggestions.dismissedAt} IS NOT NULL AND ${conversationThreadSuggestions.dismissedAt} >= ${cutoff})
      )`,
    ),
  );

  // Group rows by (orgId, accountId-or-sentinel, actionType).
  type Key = string;
  const buckets = new Map<Key, {
    orgId: string;
    accountId: string;
    actionType: string;
    wrongCount: number;
    goodCount: number;
    dismissedCount: number;
    lastWrongAt: Date | null;
    lastFeedbackAt: Date | null;
    wrongReasonsByAt: { at: Date; reason: string }[];
  }>();

  const keyOf = (orgId: string, accountId: string, actionType: string): Key =>
    `${orgId}::${accountId}::${actionType}`;

  for (const r of rows as FeedbackRow[]) {
    const accountId = (r.accountId && r.accountId.length > 0) ? r.accountId : ORG_WIDE_ACCOUNT_SENTINEL;
    const k = keyOf(r.orgId, accountId, r.actionType);
    let bucket = buckets.get(k);
    if (!bucket) {
      bucket = {
        orgId: r.orgId,
        accountId,
        actionType: r.actionType,
        wrongCount: 0,
        goodCount: 0,
        dismissedCount: 0,
        lastWrongAt: null,
        lastFeedbackAt: null,
        wrongReasonsByAt: [],
      };
      buckets.set(k, bucket);
    }

    const effectiveAt = pickEffectiveAt(r);
    if (effectiveAt && (!bucket.lastFeedbackAt || effectiveAt > bucket.lastFeedbackAt)) {
      bucket.lastFeedbackAt = effectiveAt;
    }

    if (r.feedbackKind === "wrong") {
      bucket.wrongCount += 1;
      const at = r.feedbackAt ?? effectiveAt;
      if (at && (!bucket.lastWrongAt || at > bucket.lastWrongAt)) bucket.lastWrongAt = at;
      if (r.actionReason && at) {
        bucket.wrongReasonsByAt.push({ at, reason: r.actionReason.slice(0, MAX_REASON_LEN) });
      }
    } else if (r.feedbackKind === "good") {
      bucket.goodCount += 1;
    }
    // dismissedAt is also true on "wrong" rows (we hide the card on wrong),
    // so only count standalone dismissals — feedbackKind === null AND
    // dismissedAt is set — to avoid double-counting.
    if (r.feedbackKind == null && r.dismissedAt) {
      bucket.dismissedCount += 1;
    }
  }

  // Snapshot the existing stats so we can clear keys that no longer have
  // any qualifying feedback in the window.
  const existing = await db.select({
    id: conversationSuggestionFeedbackStats.id,
    orgId: conversationSuggestionFeedbackStats.orgId,
    accountId: conversationSuggestionFeedbackStats.accountId,
    actionType: conversationSuggestionFeedbackStats.actionType,
  })
  .from(conversationSuggestionFeedbackStats);

  const seenKeys = new Set<Key>();
  let keysUpdated = 0;
  for (const bucket of buckets.values()) {
    const recentWrongReasons = bucket.wrongReasonsByAt
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, MAX_REASON_SAMPLES)
      .map(x => x.reason);

    await db.insert(conversationSuggestionFeedbackStats).values({
      orgId: bucket.orgId,
      accountId: bucket.accountId,
      actionType: bucket.actionType,
      wrongCount: bucket.wrongCount,
      goodCount: bucket.goodCount,
      dismissedCount: bucket.dismissedCount,
      recentWrongReasons,
      lastWrongAt: bucket.lastWrongAt,
      lastFeedbackAt: bucket.lastFeedbackAt,
    }).onConflictDoUpdate({
      target: [
        conversationSuggestionFeedbackStats.orgId,
        conversationSuggestionFeedbackStats.accountId,
        conversationSuggestionFeedbackStats.actionType,
      ],
      set: {
        wrongCount: bucket.wrongCount,
        goodCount: bucket.goodCount,
        dismissedCount: bucket.dismissedCount,
        recentWrongReasons,
        lastWrongAt: bucket.lastWrongAt,
        lastFeedbackAt: bucket.lastFeedbackAt,
        updatedAt: new Date(),
      },
    });
    keysUpdated += 1;
    seenKeys.add(keyOf(bucket.orgId, bucket.accountId, bucket.actionType));
  }

  // Clear stats whose keys no longer appear in the rolling window so a
  // single old "wrong" can't haunt a rep forever.
  const toClear = existing.filter(e =>
    !seenKeys.has(keyOf(e.orgId, e.accountId, e.actionType)),
  );
  let keysCleared = 0;
  for (const row of toClear) {
    await db.delete(conversationSuggestionFeedbackStats)
      .where(eq(conversationSuggestionFeedbackStats.id, row.id));
    keysCleared += 1;
  }

  logMessage(`Aggregated ${rows.length} feedback row(s) → ${keysUpdated} key(s) updated, ${keysCleared} cleared (lookback ${lookbackDays}d)`);
  return { scanned: rows.length, keysUpdated, keysCleared };
}

/**
 * Apply a single feedback event to the stats table immediately so the next
 * suggestion request reflects it without waiting for the nightly job.
 * Safe to call from the request path — small upsert, no AI calls.
 */
export async function recordIncrementalFeedback(opts: {
  orgId: string;
  accountId: string | null;
  actionType: string;
  kind: "wrong" | "good" | "dismissed";
  reason?: string | null;
  at?: Date;
}): Promise<void> {
  const accountId = opts.accountId && opts.accountId.length > 0 ? opts.accountId : ORG_WIDE_ACCOUNT_SENTINEL;
  const at = opts.at ?? new Date();

  const [existing] = await db.select().from(conversationSuggestionFeedbackStats)
    .where(and(
      eq(conversationSuggestionFeedbackStats.orgId, opts.orgId),
      eq(conversationSuggestionFeedbackStats.accountId, accountId),
      eq(conversationSuggestionFeedbackStats.actionType, opts.actionType),
    ))
    .limit(1);

  const wrongDelta = opts.kind === "wrong" ? 1 : 0;
  const goodDelta = opts.kind === "good" ? 1 : 0;
  const dismissedDelta = opts.kind === "dismissed" ? 1 : 0;
  const reason = (opts.reason ?? "").slice(0, MAX_REASON_LEN);

  if (!existing) {
    await db.insert(conversationSuggestionFeedbackStats).values({
      orgId: opts.orgId,
      accountId,
      actionType: opts.actionType,
      wrongCount: wrongDelta,
      goodCount: goodDelta,
      dismissedCount: dismissedDelta,
      recentWrongReasons: opts.kind === "wrong" && reason ? [reason] : [],
      lastWrongAt: opts.kind === "wrong" ? at : null,
      lastFeedbackAt: at,
    }).onConflictDoNothing();
    return;
  }

  const recent = Array.isArray(existing.recentWrongReasons) ? [...existing.recentWrongReasons] : [];
  if (opts.kind === "wrong" && reason) {
    recent.unshift(reason);
    while (recent.length > MAX_REASON_SAMPLES) recent.pop();
  }

  await db.update(conversationSuggestionFeedbackStats)
    .set({
      wrongCount: existing.wrongCount + wrongDelta,
      goodCount: existing.goodCount + goodDelta,
      dismissedCount: existing.dismissedCount + dismissedDelta,
      recentWrongReasons: recent,
      lastWrongAt: opts.kind === "wrong" ? at : existing.lastWrongAt,
      lastFeedbackAt: at,
      updatedAt: new Date(),
    })
    .where(eq(conversationSuggestionFeedbackStats.id, existing.id));
}

export interface AccountFeedbackInsight {
  /** Action types the suggestion service should avoid recommending. */
  downweighted: Set<SuggestionActionType>;
  /** Up to a handful of recent rejected reasons across all action types,
   *  for the AI refinement prompt. */
  recentWrongReasons: string[];
  /** Raw rows in case callers want to inspect counts. */
  rows: ConversationSuggestionFeedbackStats[];
}

/**
 * Pure helper: decide downweighting + reason pool from a snapshot of
 * stats rows. Split out so the unit test can drive it directly without
 * standing up a live `db`. Exported via `__testing` below.
 */
function deriveInsightFromRows(
  rows: ConversationSuggestionFeedbackStats[],
  accountId: string,
  now: Date = new Date(),
): AccountFeedbackInsight {
  const cutoff = new Date(now.getTime() - DOWNWEIGHT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const downweighted = new Set<SuggestionActionType>();
  const reasonsByAt: { at: Date; reason: string }[] = [];

  for (const row of rows) {
    // Only the same account's signal can downweight an action — the
    // org-wide rollup is just used to show patterns to the AI prompt.
    const isSameAccount = row.accountId === accountId;
    if (
      isSameAccount
      && row.wrongCount > row.goodCount
      && row.lastWrongAt
      && row.lastWrongAt >= cutoff
    ) {
      downweighted.add(row.actionType as SuggestionActionType);
    }
    const reasons = Array.isArray(row.recentWrongReasons) ? row.recentWrongReasons : [];
    const at = row.lastWrongAt ?? row.lastFeedbackAt ?? row.updatedAt;
    for (const reason of reasons) {
      if (reason && typeof reason === "string") reasonsByAt.push({ at, reason });
    }
  }

  // Never downweight the safe default — reps need *something* to do.
  downweighted.delete("draft_reply");
  downweighted.delete("none");
  downweighted.delete("await_response");

  const recentWrongReasons = reasonsByAt
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, MAX_REASON_SAMPLES)
    .map(x => x.reason);

  return { downweighted, recentWrongReasons, rows };
}

/**
 * Look up everything the suggestion service needs to know about a
 * (org, account) pair: which actions are currently downweighted (rep
 * marked wrong within the last 7 days AND wrong > good for that key) and a
 * pooled list of recent rejected reasons to feed the AI prompt.
 */
export async function getAccountFeedbackInsight(opts: {
  orgId: string;
  accountId: string | null;
}): Promise<AccountFeedbackInsight> {
  const accountId = opts.accountId && opts.accountId.length > 0 ? opts.accountId : ORG_WIDE_ACCOUNT_SENTINEL;

  // Pull both the account-specific and the org-wide rollup so unlinked
  // patterns can still inform a linked-account thread (and vice versa).
  const accountIds = accountId === ORG_WIDE_ACCOUNT_SENTINEL
    ? [ORG_WIDE_ACCOUNT_SENTINEL]
    : [accountId, ORG_WIDE_ACCOUNT_SENTINEL];

  const rows = await db.select().from(conversationSuggestionFeedbackStats)
    .where(and(
      eq(conversationSuggestionFeedbackStats.orgId, opts.orgId),
      inArray(conversationSuggestionFeedbackStats.accountId, accountIds),
    ));

  return deriveInsightFromRows(rows, accountId);
}

export const __testing = {
  ORG_WIDE_ACCOUNT_SENTINEL,
  DOWNWEIGHT_WINDOW_DAYS,
  MAX_REASON_SAMPLES,
  deriveInsightFromRows,
};
