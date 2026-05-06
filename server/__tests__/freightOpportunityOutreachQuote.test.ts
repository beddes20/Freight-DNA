/**
 * Task #637 — PAFOE classifyOpportunityReply quote-event wiring.
 *
 * Verifies the third reviewer-blocker fix:
 *   1. extractQuotedRate parses common carrier rate phrasings.
 *   2. When a carrier reply contains a parseable rate AND we have a matched
 *      carrier + lane parts on the opportunity, classifyOpportunityReply
 *      bumps quote_count via recordCarrierLaneOutcome with a stable
 *      response-id-keyed eventKey.
 *   3. The same numeric rate is persisted onto the response row (no longer
 *      hard-coded to null).
 *
 * Strategy: stub storage + recordCarrierLaneOutcome, force the heuristic
 * fallback inside classifyReplyWithLLM by clearing OPENAI_API_KEY.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const recordMock = vi.fn(async () => undefined);
vi.mock("../services/carrierLaneOutcomes", () => ({
  recordCarrierLaneOutcome: (...args: unknown[]) => recordMock(...args),
  getCarrierLaneOutcomesForLane: vi.fn(async () => new Map()),
  summarizeCarrierLaneOutcome: vi.fn(() => null),
  carrierLaneOutcomePrior: vi.fn(() => ({ delta: 0, reason: null })),
}));

import {
  extractQuotedRate,
  classifyOpportunityReply,
} from "../freightOpportunityOutreachService";
import type { IStorage } from "../storage";

const oppId = "opp-1";
const oppCarrierId = "oppc-1";
const carrierId = "car-1";
const responseId = "resp-1";

function makeStorage(createSpy: ReturnType<typeof vi.fn>): IStorage {
  return {
    findOpportunityCarriersByThreadOrMessage: vi.fn(async () => [
      { id: oppCarrierId, opportunityId: oppId, carrierId },
    ]),
    getFreightOpportunity: vi.fn(async () => ({
      id: oppId,
      orgId: "org-1",
      mode: "exact_load",
      origin: "Chicago",
      originState: "IL",
      destination: "Dallas",
      destinationState: "TX",
      equipmentType: "Dry Van",
      status: "awaiting_carrier_reply",
    })),
    // getOrSeedTemplate calls this; return a stub so the helper short-circuits
    // before it would try to insert a default into the DB.
    getFreightOutreachTemplate: vi.fn(async () => ({
      body: "Outbound template body",
      subject: "Lane outreach",
    })),
    createFreightOpportunityResponse: createSpy,
    updateFreightOpportunityCarrier: vi.fn(async () => undefined),
    appendFreightOpportunityAudit: vi.fn(async () => undefined),
    updateFreightOpportunity: vi.fn(async () => undefined),
    // feedbackToCarrierIntel may call additional storage methods at the tail
    // of classifyOpportunityReply; tolerate missing methods by no-op'ing
    // through a Proxy fallback.
  } as unknown as IStorage;
}

const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;
beforeEach(() => {
  recordMock.mockReset();
  // Force the heuristic fallback path so no live OpenAI request is made.
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => {
  if (ORIGINAL_OPENAI_KEY !== undefined) process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_KEY;
});

describe("extractQuotedRate", () => {
  it("parses dollar-sign amounts with commas", () => {
    expect(extractQuotedRate("Sure, I can do this for $2,500 all in.")).toBe(2500);
  });
  it("parses dollar-sign amounts without commas", () => {
    expect(extractQuotedRate("Rate is $1800")).toBe(1800);
  });
  it("parses keyword-followed bare numbers", () => {
    expect(extractQuotedRate("our rate would be 2200 to cover")).toBe(2200);
    expect(extractQuotedRate("can do it for 1750")).toBe(1750);
  });
  it("returns null when no plausible amount is present", () => {
    expect(extractQuotedRate("not interested, sorry")).toBeNull();
    expect(extractQuotedRate("")).toBeNull();
  });
  it("rejects out-of-range numbers (truck count, zip code)", () => {
    expect(extractQuotedRate("we have 3 trucks running")).toBeNull();
    expect(extractQuotedRate("zip 60601 origin")).toBeNull();
  });
});

describe("classifyOpportunityReply quote bump (Task #637)", () => {
  it("bumps quote_count and persists rate when reply body contains a parseable rate", async () => {
    const createSpy = vi.fn(async () => ({ id: responseId, outcome: "interested_now" }));
    const storage = makeStorage(createSpy);
    await classifyOpportunityReply(storage, {
      orgId: "org-1",
      conversationId: "conv-1",
      internetMessageId: "msg-1",
      fromEmail: "carrier@example.com",
      subject: "Re: Chicago to Dallas dry van",
      bodyFull: "Yes, interested. Rate is $2,500 all in.",
      providerMessageId: "msg-1",
      emailMessageId: null,
    });

    // Response row carries the extracted rate (string-encoded for the
    // numeric column type), not null.
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect((createSpy.mock.calls[0][0] as { quotedRate: string | null }).quotedRate).toBe("2500");

    // Recorded events: reply + yes (interested_now is positive) + quote.
    const events = recordMock.mock.calls.map(c => (c[0] as { event: string; eventKey: string }));
    const evNames = events.map(e => e.event).sort();
    expect(evNames).toEqual(["quote", "reply", "yes"]);

    const quote = events.find(e => e.event === "quote");
    expect(quote).toBeDefined();
    expect(quote!.eventKey).toBe(`pafoe-reply:${responseId}:quote`);
  });

  it("does NOT bump quote_count when reply body has no parseable rate", async () => {
    const createSpy = vi.fn(async () => ({ id: responseId, outcome: "interested_now" }));
    const storage = makeStorage(createSpy);
    await classifyOpportunityReply(storage, {
      orgId: "org-1",
      conversationId: "conv-1",
      internetMessageId: "msg-1",
      fromEmail: "carrier@example.com",
      subject: "Re: Chicago to Dallas dry van",
      bodyFull: "Yes, interested. Send rate-con please.",
      providerMessageId: "msg-1",
      emailMessageId: null,
    });

    expect((createSpy.mock.calls[0][0] as { quotedRate: string | null }).quotedRate).toBeNull();
    const evNames = recordMock.mock.calls.map(c => (c[0] as { event: string }).event).sort();
    expect(evNames).toEqual(["reply", "yes"]);
  });

  it("bumps quote_count even on a declined reply when a rate is present", async () => {
    // A carrier saying "I'd need $3,200 to do this, otherwise pass" still
    // gives us a real quote signal even though the outcome is negative.
    const createSpy = vi.fn(async () => ({ id: responseId, outcome: "declined" }));
    const storage = makeStorage(createSpy);
    await classifyOpportunityReply(storage, {
      orgId: "org-1",
      conversationId: "conv-1",
      internetMessageId: "msg-1",
      fromEmail: "carrier@example.com",
      subject: "Re: Chicago to Dallas dry van",
      bodyFull: "no thanks at that price — I would need $3,200 to run it.",
      providerMessageId: "msg-1",
      emailMessageId: null,
    });

    const events = recordMock.mock.calls.map(c => (c[0] as { event: string }));
    const evNames = events.map(e => e.event).sort();
    // declined → loss + reply, plus quote because rate was extracted.
    expect(evNames).toEqual(["loss", "quote", "reply"]);
  });
});
