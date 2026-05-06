/**
 * Task #912 — Outcome wiring helpers.
 *
 * `copilotRecommendationOutcomes.ts` exposes pure functions that:
 *   1. Look up the most recent card for an anchor (opportunity / customer /
 *      lane).
 *   2. Merge an outcome patch into `downstreamOutcome` via storage.
 *   3. Return the updated card, or null when no card exists for the anchor.
 *
 * We mock the storage module so these tests are pure-unit and never touch
 * the DB. The behaviors we pin:
 *
 *   - "no card" → null is returned, no write happens.
 *   - "card exists" → recordRecommendationOutcome is called with a payload
 *     keyed by `patch.kind`.
 *   - The outcome payload always includes (at, detail, amount, resolvedById).
 *   - Calling twice for the same card merges (each call passes a separate
 *     keyed object; storage's merge contract preserves prior keys).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CopilotRecommendation } from "@shared/schema";

const recordRecommendationOutcome = vi.fn();
const listRecommendationsForOpportunity = vi.fn();
const listRecommendationsForCustomer = vi.fn();
const listRecommendationsForLane = vi.fn();

vi.mock("../storage", () => ({
  storage: {
    recordRecommendationOutcome: (...args: unknown[]) => recordRecommendationOutcome(...args),
    listRecommendationsForOpportunity: (...args: unknown[]) => listRecommendationsForOpportunity(...args),
    listRecommendationsForCustomer: (...args: unknown[]) => listRecommendationsForCustomer(...args),
    listRecommendationsForLane: (...args: unknown[]) => listRecommendationsForLane(...args),
  },
  db: {},
}));

import {
  recordOutcomeForOpportunity,
  recordOutcomeForCustomer,
  recordOutcomeForLane,
  recordOutcomeForCard,
} from "../services/copilotRecommendationOutcomes";

function mkCard(over: Partial<CopilotRecommendation> = {}): CopilotRecommendation {
  return {
    id: "rec_1",
    orgId: "org_1",
    sourceDocumentId: "doc_1",
    sourceKind: "rate_con",
    customerCompanyId: "company_1",
    carrierId: null,
    opportunityId: "opp_1",
    laneSignature: "atl_ga|mia_fl|dryvan",
    cardPayload: {},
    suggestedPlays: [],
    sourceRecords: [],
    aggregateConfidence: "high",
    fitScore: 80,
    generatedByUserId: null,
    generatedAt: new Date(),
    reaction: "pending",
    reactionReason: null,
    reactedAt: null,
    reactedByUserId: null,
    downstreamOutcome: null,
    outcomeResolvedAt: null,
    ...over,
  } as unknown as CopilotRecommendation;
}

beforeEach(() => {
  recordRecommendationOutcome.mockReset();
  listRecommendationsForOpportunity.mockReset();
  listRecommendationsForCustomer.mockReset();
  listRecommendationsForLane.mockReset();
});

describe("recordOutcomeForOpportunity", () => {
  it("returns null and does NOT write when no card exists for the opportunity", async () => {
    listRecommendationsForOpportunity.mockResolvedValueOnce([]);
    const out = await recordOutcomeForOpportunity("org_1", "opp_missing", { kind: "opportunity_won" });
    expect(out).toBeNull();
    expect(recordRecommendationOutcome).not.toHaveBeenCalled();
  });

  it("forwards a kind-keyed payload to storage when a card exists", async () => {
    const card = mkCard();
    listRecommendationsForOpportunity.mockResolvedValueOnce([card]);
    recordRecommendationOutcome.mockResolvedValueOnce({ ...card, downstreamOutcome: { opportunity_won: {} } });
    const out = await recordOutcomeForOpportunity("org_1", "opp_1", {
      kind: "opportunity_won",
      detail: "covered at 1850",
      amount: 1850,
      resolvedById: "user_1",
    });
    expect(out).not.toBeNull();
    expect(recordRecommendationOutcome).toHaveBeenCalledTimes(1);
    const [id, orgId, payload] = recordRecommendationOutcome.mock.calls[0];
    expect(id).toBe("rec_1");
    expect(orgId).toBe("org_1");
    const wonPatch = (payload as Record<string, { at: string; detail: string | null; amount: number | null; resolvedById: string | null }>).opportunity_won;
    expect(wonPatch).toBeDefined();
    expect(wonPatch.detail).toBe("covered at 1850");
    expect(wonPatch.amount).toBe(1850);
    expect(wonPatch.resolvedById).toBe("user_1");
    expect(typeof wonPatch.at).toBe("string");
    expect(new Date(wonPatch.at).toString()).not.toBe("Invalid Date");
  });

  it("defaults detail/amount/resolvedById to null when not provided", async () => {
    const card = mkCard();
    listRecommendationsForOpportunity.mockResolvedValueOnce([card]);
    recordRecommendationOutcome.mockResolvedValueOnce(card);
    await recordOutcomeForOpportunity("org_1", "opp_1", { kind: "opportunity_lost" });
    const payload = recordRecommendationOutcome.mock.calls[0][2] as Record<string, { detail: unknown; amount: unknown; resolvedById: unknown }>;
    expect(payload.opportunity_lost.detail).toBeNull();
    expect(payload.opportunity_lost.amount).toBeNull();
    expect(payload.opportunity_lost.resolvedById).toBeNull();
  });
});

describe("recordOutcomeForCustomer", () => {
  it("looks up the latest customer card and forwards the patch", async () => {
    const card = mkCard({ id: "rec_cust" });
    listRecommendationsForCustomer.mockResolvedValueOnce([card]);
    recordRecommendationOutcome.mockResolvedValueOnce(card);
    const out = await recordOutcomeForCustomer("org_1", "company_1", { kind: "capture_failure_resolved" });
    expect(out).toBe(card);
    expect(listRecommendationsForCustomer).toHaveBeenCalledWith("company_1", "org_1", 1);
    const [id, , payload] = recordRecommendationOutcome.mock.calls[0];
    expect(id).toBe("rec_cust");
    expect((payload as Record<string, unknown>).capture_failure_resolved).toBeDefined();
  });

  it("returns null when no customer card exists", async () => {
    listRecommendationsForCustomer.mockResolvedValueOnce([]);
    const out = await recordOutcomeForCustomer("org_1", "company_unknown", { kind: "capture_failure_resolved" });
    expect(out).toBeNull();
    expect(recordRecommendationOutcome).not.toHaveBeenCalled();
  });
});

describe("recordOutcomeForLane", () => {
  it("forwards a leak_resolved patch keyed by kind", async () => {
    const card = mkCard({ id: "rec_lane", laneSignature: "atl_ga|mia_fl|dryvan" });
    listRecommendationsForLane.mockResolvedValueOnce([card]);
    recordRecommendationOutcome.mockResolvedValueOnce(card);
    await recordOutcomeForLane("org_1", "atl_ga|mia_fl|dryvan", { kind: "leak_resolved", detail: "moved to recurring program" });
    expect(listRecommendationsForLane).toHaveBeenCalledWith("atl_ga|mia_fl|dryvan", "org_1", 1);
    const payload = recordRecommendationOutcome.mock.calls[0][2] as Record<string, { detail: unknown }>;
    expect(payload.leak_resolved.detail).toBe("moved to recurring program");
  });
});

describe("recordOutcomeForCard", () => {
  it("writes directly without a lookup when called with a recommendation id", async () => {
    recordRecommendationOutcome.mockResolvedValueOnce(mkCard({ id: "rec_direct" }));
    const out = await recordOutcomeForCard("org_1", "rec_direct", {
      kind: "available_freight_converted",
      amount: 2200,
    });
    expect(out).not.toBeNull();
    expect(listRecommendationsForOpportunity).not.toHaveBeenCalled();
    expect(listRecommendationsForCustomer).not.toHaveBeenCalled();
    expect(listRecommendationsForLane).not.toHaveBeenCalled();
    expect(recordRecommendationOutcome).toHaveBeenCalledWith("rec_direct", "org_1", expect.objectContaining({
      available_freight_converted: expect.objectContaining({ amount: 2200 }),
    }));
  });
});
