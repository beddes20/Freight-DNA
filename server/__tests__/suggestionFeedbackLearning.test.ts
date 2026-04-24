/**
 * Suggestion Feedback Learning — Test Suite (Task #552)
 *
 * Pure-logic tests for the rule that decides which suggestion action types
 * to downweight for an account based on recent rep feedback. The DB-touching
 * paths (aggregateSuggestionFeedback / recordIncrementalFeedback) are
 * exercised by the integration suite; here we verify the small but
 * important "is this stat fresh and damning enough to silence a
 * suggestion?" decision.
 */

import { describe, it, expect, vi } from "vitest";
import type { ConversationSuggestionFeedbackStats } from "@shared/schema";

// The service touches `db` at module load via getAccountFeedbackInsight, so
// stub the storage import before requiring the module.
vi.mock("../storage", () => ({ db: {} as any }));

import { __testing } from "../services/suggestionFeedbackLearningService";

const { deriveInsightFromRows, DOWNWEIGHT_WINDOW_DAYS, ORG_WIDE_ACCOUNT_SENTINEL } = __testing;

function makeStat(overrides: Partial<ConversationSuggestionFeedbackStats> = {}): ConversationSuggestionFeedbackStats {
  return {
    id: "stats-1",
    orgId: "org-1",
    accountId: "acct-1",
    actionType: "quote_request_reply",
    wrongCount: 0,
    goodCount: 0,
    dismissedCount: 0,
    recentWrongReasons: [],
    lastWrongAt: null,
    lastFeedbackAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

const NOW = new Date("2026-04-24T12:00:00Z");
const TWO_DAYS_AGO = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
const TEN_DAYS_AGO = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);

describe("deriveInsightFromRows — Task #552", () => {
  it("downweights an action when wrong > good and last_wrong is within 7 days", () => {
    const rows = [makeStat({
      actionType: "quote_request_reply",
      wrongCount: 2,
      goodCount: 0,
      lastWrongAt: TWO_DAYS_AGO,
      recentWrongReasons: ["They asked about pricing"],
    })];
    const insight = deriveInsightFromRows(rows, "acct-1", NOW);
    expect(insight.downweighted.has("quote_request_reply")).toBe(true);
    expect(insight.recentWrongReasons).toContain("They asked about pricing");
  });

  it("does NOT downweight when last_wrong is older than the 7-day window", () => {
    const rows = [makeStat({
      actionType: "quote_request_reply",
      wrongCount: 5,
      goodCount: 0,
      lastWrongAt: TEN_DAYS_AGO,
    })];
    const insight = deriveInsightFromRows(rows, "acct-1", NOW);
    expect(insight.downweighted.has("quote_request_reply")).toBe(false);
  });

  it("does NOT downweight when good >= wrong (rep changed their mind)", () => {
    const rows = [makeStat({
      actionType: "mark_resolved",
      wrongCount: 1,
      goodCount: 2,
      lastWrongAt: TWO_DAYS_AGO,
    })];
    const insight = deriveInsightFromRows(rows, "acct-1", NOW);
    expect(insight.downweighted.has("mark_resolved")).toBe(false);
  });

  it("never downweights the safe-default actions (draft_reply, none, await_response)", () => {
    const rows = [
      makeStat({ actionType: "draft_reply", wrongCount: 5, goodCount: 0, lastWrongAt: TWO_DAYS_AGO }),
      makeStat({ id: "stats-2", actionType: "none", wrongCount: 5, goodCount: 0, lastWrongAt: TWO_DAYS_AGO }),
      makeStat({ id: "stats-3", actionType: "await_response", wrongCount: 5, goodCount: 0, lastWrongAt: TWO_DAYS_AGO }),
    ];
    const insight = deriveInsightFromRows(rows, "acct-1", NOW);
    expect(insight.downweighted.has("draft_reply")).toBe(false);
    expect(insight.downweighted.has("none")).toBe(false);
    expect(insight.downweighted.has("await_response")).toBe(false);
  });

  it("uses org-wide rollup only for reasons, never for downweighting", () => {
    const rows = [makeStat({
      accountId: ORG_WIDE_ACCOUNT_SENTINEL,
      actionType: "quote_request_reply",
      wrongCount: 5,
      goodCount: 0,
      lastWrongAt: TWO_DAYS_AGO,
      recentWrongReasons: ["org-wide rejected reason"],
    })];
    const insight = deriveInsightFromRows(rows, "acct-1", NOW);
    expect(insight.downweighted.has("quote_request_reply")).toBe(false);
    expect(insight.recentWrongReasons).toContain("org-wide rejected reason");
  });

  it("returns recent wrong reasons sorted most-recent-first and capped at 5", () => {
    const dates = Array.from({ length: 8 }, (_, i) =>
      new Date(NOW.getTime() - (i + 1) * 60 * 60 * 1000));
    const rows = dates.map((d, i) => makeStat({
      id: `stats-${i}`,
      actionType: "quote_request_reply",
      wrongCount: 1,
      goodCount: 0,
      lastWrongAt: d,
      recentWrongReasons: [`reason ${i}`],
    }));
    const insight = deriveInsightFromRows(rows, "acct-1", NOW);
    expect(insight.recentWrongReasons.length).toBe(5);
    // Most-recent-first → "reason 0" (which is 1h ago) should come first.
    expect(insight.recentWrongReasons[0]).toBe("reason 0");
  });

  it("constants reflect 7-day downweight window", () => {
    expect(DOWNWEIGHT_WINDOW_DAYS).toBe(7);
  });
});
