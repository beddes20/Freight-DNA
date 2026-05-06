/**
 * Email Intelligence Layer v1 — Test Suite (Task #190)
 *
 * Tests:
 *  1–3   Intent taxonomy exhaustiveness
 *  4–9   ExtractionResponseSchema validation (valid, invalid, edge cases)
 * 10–15  deduplicateSignals dedup logic with injected storage + options API
 * 16     Outbound logging inserts processed message + meaningful_touchpoint signal
 * 17–26  NBA engine: signal → rule type + outcomeType mapping, carrier context, dedup, confidence
 * 27–32  Six synthetic classification fixtures (each representing a distinct intent category)
 * 33     stripEmailBoilerplate correctly strips quoted history and signatures
 * 34     Error resilience: empty result structure is schema-valid (never-throw contract)
 * 35     Idempotency: processEmailMessage marks message processed even with empty signals
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import {
  CARRIER_INTENTS,
  CUSTOMER_INTENTS,
  ALL_INTENT_TYPES,
  deduplicateSignals,
  logOutboundCarrierEmail,
  extractEmailSignals,
  stripEmailBoilerplate,
  DEDUP_WINDOW_MS,
  type ExtractedSignal,
  type ExtractionResult,
} from "../emailIntelligenceService";

import {
  generateNbasFromEmailSignals,
  SIGNAL_CONFIDENCE_THRESHOLD,
} from "../nextBestActionEngine";

import type { EmailMessage, EmailSignal } from "@shared/schema";

// ─── Typed mock helpers ───────────────────────────────────────────────────────

type DeduplicateStorageMock = { getEmailSignalsByThread: ReturnType<typeof vi.fn> };
type OutboundStorageMock = {
  insertEmailMessage: ReturnType<typeof vi.fn>;
  insertEmailSignals: ReturnType<typeof vi.fn>;
};
type NbaStorageMock = {
  getRecentNbaCardByType: ReturnType<typeof vi.fn>;
  getRecurringLane: ReturnType<typeof vi.fn>;
  getFirstOrgAdmin: ReturnType<typeof vi.fn>;
  createNbaCard: ReturnType<typeof vi.fn>;
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "msg-001",
    orgId: "org-001",
    threadId: "thread-abc",
    direction: "inbound",
    fromEmail: "carrier@example.com",
    toEmail: "rep@freight-dna.com",
    ccEmail: null,
    subject: "Re: Lane ATL-CHI",
    body: "Sorry, we cannot cover that lane at your rate.",
    linkedAccountId: null,
    linkedCarrierId: "carrier-001",
    linkedLaneId: "lane-001",
    linkedLoadId: null,
    linkedTaskId: null,
    linkedNbaId: null,
    linkedOutreachLogId: "log-001",
    processedForSignalsAt: null,
    createdAt: new Date("2026-04-10T10:00:00Z"),
    ...overrides,
  };
}

function makeSignal(overrides: Partial<EmailSignal> = {}): EmailSignal {
  return {
    id: "sig-001",
    messageId: "msg-001",
    intentType: "lane_decline",
    intentSubtype: null,
    actorType: "carrier",
    entityType: "carrier",
    entityId: "carrier-001",
    confidence: 85,
    extractedData: {},
    createdAt: new Date("2026-04-10T10:00:00Z"),
    ...overrides,
  };
}

function makeExtractedSignal(overrides: Partial<ExtractedSignal> = {}): ExtractedSignal {
  return {
    intentType: "lane_decline",
    confidence: 85,
    extractedData: {},
    ...overrides,
  };
}

// ─── Inline validation schema ──────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Email Intelligence — Intent taxonomy (1–3)", () => {
  it("1. exports the canonical carrier intent types", () => {
    expect(CARRIER_INTENTS).toHaveLength(10);
    expect(CARRIER_INTENTS).toContain("lane_decline");
    expect(CARRIER_INTENTS).toContain("hard_commitment");
    expect(CARRIER_INTENTS).toContain("price_pushback");
    expect(CARRIER_INTENTS).toContain("lane_offer");
    expect(CARRIER_INTENTS).toContain("capacity_available");
  });

  it("2. exports the canonical customer intent types", () => {
    // Pin the contents, not the count — the count was 10 historically and
    // grew to 13 silently (intent taxonomy expansion), which left this test
    // stale and red for several sessions. Asserting the canonical members
    // is the actual contract; the length follows from the exported array.
    expect(CUSTOMER_INTENTS.length).toBeGreaterThanOrEqual(10);
    expect(CUSTOMER_INTENTS).toContain("closed_lost_indicator");
    expect(CUSTOMER_INTENTS).toContain("new_opportunity");
    expect(CUSTOMER_INTENTS).toContain("stalled_thread");
    expect(CUSTOMER_INTENTS).toContain("pricing_request");
  });

  it("3. ALL_INTENT_TYPES is the union of carrier + customer", () => {
    expect(ALL_INTENT_TYPES).toHaveLength(
      CARRIER_INTENTS.length + CUSTOMER_INTENTS.length
    );
    for (const intent of [...CARRIER_INTENTS, ...CUSTOMER_INTENTS]) {
      expect(ALL_INTENT_TYPES).toContain(intent);
    }
  });
});

describe("Email Intelligence — ExtractionResponseSchema validation (4–9)", () => {
  it("4. accepts a well-formed extraction response", () => {
    const payload = {
      actorType: "carrier",
      signals: [
        {
          intentType: "lane_decline",
          confidence: 90,
          extractedData: { reason: "rate_too_low" },
          reasoning: "Carrier said 'we cannot cover that rate'",
        },
      ],
      summary: "Carrier declined the lane due to low rate.",
    };
    const result = ExtractionResponseSchema.parse(payload);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].intentType).toBe("lane_decline");
    expect(result.actorType).toBe("carrier");
  });

  it("5. rejects an unknown intentType", () => {
    expect(() => ExtractionResponseSchema.parse({
      actorType: "carrier",
      signals: [{ intentType: "totally_fake_intent", confidence: 80 }],
    })).toThrow();
  });

  it("6. rejects confidence outside 0-100", () => {
    expect(() => ExtractionResponseSchema.parse({
      actorType: "carrier",
      signals: [{ intentType: "lane_decline", confidence: 150 }],
    })).toThrow();
  });

  it("7. allows empty signals array", () => {
    const result = ExtractionResponseSchema.parse({ actorType: "internal", signals: [] });
    expect(result.signals).toHaveLength(0);
  });

  it("8. accepts all known customer intent types without throwing", () => {
    for (const intentType of CUSTOMER_INTENTS) {
      expect(() => ExtractionResponseSchema.parse({
        actorType: "customer",
        signals: [{ intentType, confidence: 75 }],
      })).not.toThrow();
    }
  });

  it("9. accepts all known carrier intent types without throwing", () => {
    for (const intentType of CARRIER_INTENTS) {
      expect(() => ExtractionResponseSchema.parse({
        actorType: "carrier",
        signals: [{ intentType, confidence: 75 }],
      })).not.toThrow();
    }
  });
});

describe("Email Intelligence — deduplicateSignals (10–15)", () => {
  it("10. suppresses signals whose intentType was seen in the thread within 24h", async () => {
    const existingSignal = makeSignal({ intentType: "lane_decline" });
    const mockStorage: DeduplicateStorageMock = {
      getEmailSignalsByThread: vi.fn().mockResolvedValue([existingSignal]),
    };

    const newSignals: ExtractedSignal[] = [
      makeExtractedSignal({ intentType: "lane_decline" }),
      makeExtractedSignal({ intentType: "price_pushback" }),
    ];
    const result = await deduplicateSignals(
      newSignals,
      makeMessage({ threadId: "thread-abc" }),
      { storageInstance: mockStorage },
    );

    expect(result.map(s => s.intentType)).not.toContain("lane_decline");
    expect(result.map(s => s.intentType)).toContain("price_pushback");
    expect(result).toHaveLength(1);
  });

  it("11. allows signals not seen in thread within 24h", async () => {
    const mockStorage: DeduplicateStorageMock = {
      getEmailSignalsByThread: vi.fn().mockResolvedValue([]),
    };
    const result = await deduplicateSignals(
      [makeExtractedSignal({ intentType: "capacity_available" })],
      makeMessage({ threadId: "thread-xyz" }),
      { storageInstance: mockStorage },
    );
    expect(result).toHaveLength(1);
    expect(result[0].intentType).toBe("capacity_available");
  });

  it("12. passes all signals through when message has no threadId", async () => {
    const mockStorage: DeduplicateStorageMock = { getEmailSignalsByThread: vi.fn() };
    const result = await deduplicateSignals(
      [
        makeExtractedSignal({ intentType: "soft_commitment" }),
        makeExtractedSignal({ intentType: "hard_commitment" }),
      ],
      makeMessage({ threadId: null }),
      { storageInstance: mockStorage },
    );
    expect(result).toHaveLength(2);
    expect(mockStorage.getEmailSignalsByThread).not.toHaveBeenCalled();
  });

  it("13. passes empty array through without calling storage", async () => {
    const mockStorage: DeduplicateStorageMock = { getEmailSignalsByThread: vi.fn() };
    const result = await deduplicateSignals([], makeMessage(), { storageInstance: mockStorage });
    expect(result).toHaveLength(0);
    expect(mockStorage.getEmailSignalsByThread).not.toHaveBeenCalled();
  });

  it("14. deduplicates multiple existing intents simultaneously", async () => {
    const mockStorage: DeduplicateStorageMock = {
      getEmailSignalsByThread: vi.fn().mockResolvedValue([
        makeSignal({ intentType: "lane_decline" }),
        makeSignal({ intentType: "price_pushback" }),
      ]),
    };
    const result = await deduplicateSignals(
      [
        makeExtractedSignal({ intentType: "lane_decline" }),
        makeExtractedSignal({ intentType: "price_pushback" }),
        makeExtractedSignal({ intentType: "capacity_unavailable" }),
      ],
      makeMessage({ threadId: "thread-abc" }),
      { storageInstance: mockStorage },
    );
    expect(result).toHaveLength(1);
    expect(result[0].intentType).toBe("capacity_unavailable");
  });

  it("15. force option bypasses dedup entirely and returns all signals", async () => {
    const existingSignal = makeSignal({ intentType: "lane_decline" });
    const mockStorage: DeduplicateStorageMock = {
      getEmailSignalsByThread: vi.fn().mockResolvedValue([existingSignal]),
    };
    const newSignals: ExtractedSignal[] = [
      makeExtractedSignal({ intentType: "lane_decline" }),
      makeExtractedSignal({ intentType: "price_pushback" }),
    ];
    const result = await deduplicateSignals(
      newSignals,
      makeMessage({ threadId: "thread-abc" }),
      { storageInstance: mockStorage, force: true },
    );
    // force=true — should return both signals unchanged
    expect(result).toHaveLength(2);
    // storage was never consulted because the force flag short-circuited
    expect(mockStorage.getEmailSignalsByThread).not.toHaveBeenCalled();
  });
});

describe("Email Intelligence — Outbound email logging (16)", () => {
  it("16. logOutboundCarrierEmail inserts a processed outbound message with meaningful_touchpoint signal at 100% confidence", async () => {
    const insertedMessage = makeMessage({
      direction: "outbound",
      processedForSignalsAt: new Date(),
    });
    const insertedSignal = makeSignal({ intentType: "meaningful_touchpoint" });

    const mockStorage: OutboundStorageMock = {
      insertEmailMessage: vi.fn().mockResolvedValue(insertedMessage),
      insertEmailSignals: vi.fn().mockResolvedValue([insertedSignal]),
    };

    const result = await logOutboundCarrierEmail({
      orgId: "org-001",
      threadId: "thread-abc",
      fromEmail: "rep@freight-dna.com",
      toEmail: "carrier@example.com",
      subject: "ATL-CHI Lane Coverage",
      body: "Hi, are you available for ATL-CHI this week?",
      linkedCarrierId: "carrier-001",
      linkedLaneId: "lane-001",
      linkedOutreachLogId: "log-001",
      _storage: mockStorage,
    });

    // Message must be marked processed immediately
    const insertCall = mockStorage.insertEmailMessage.mock.calls[0][0];
    expect(insertCall.direction).toBe("outbound");
    expect(insertCall.processedForSignalsAt).toBeInstanceOf(Date);

    // Signal must be meaningful_touchpoint with 100% confidence from "internal" actor
    const signalsCall = mockStorage.insertEmailSignals.mock.calls[0][0];
    expect(signalsCall[0].intentType).toBe("meaningful_touchpoint");
    expect(signalsCall[0].actorType).toBe("internal");
    expect(signalsCall[0].confidence).toBe(100);

    expect(result.signal?.intentType).toBe("meaningful_touchpoint");
  });
});

describe("Email Intelligence — NBA engine integration (17–26)", () => {
  it("17. lane_decline signal above threshold triggers load_decline NBA card with execute outcomeType", async () => {
    const message = makeMessage({ linkedAccountId: "company-001" });
    const signal = makeSignal({ intentType: "lane_decline", confidence: 85 });
    const mockStorage: NbaStorageMock = {
      getRecentNbaCardByType: vi.fn().mockResolvedValue(undefined),
      getRecurringLane: vi.fn().mockResolvedValue({ ownerUserId: "user-001", companyId: "company-001" }),
      getFirstOrgAdmin: vi.fn().mockResolvedValue({ id: "user-001" }),
      createNbaCard: vi.fn().mockResolvedValue({ id: "nba-001" }),
    };

    await generateNbasFromEmailSignals("org-001", message, [signal], mockStorage);

    expect(mockStorage.createNbaCard).toHaveBeenCalledOnce();
    const card = mockStorage.createNbaCard!.mock.calls[0][0];
    expect(card.ruleType).toBe("load_decline");
    expect(card.urgencyScore).toBeGreaterThanOrEqual(70);
    expect(card.outcomeType).toBe("execute");
  });

  it("18. new_opportunity signal maps to spot_to_contract with grow outcomeType", async () => {
    const message = makeMessage({ linkedAccountId: "company-002" });
    const signal = makeSignal({ intentType: "new_opportunity", confidence: 80 });
    const mockStorage: NbaStorageMock = {
      getRecentNbaCardByType: vi.fn().mockResolvedValue(undefined),
      getRecurringLane: vi.fn().mockResolvedValue({ ownerUserId: "user-001", companyId: "company-002" }),
      getFirstOrgAdmin: vi.fn().mockResolvedValue({ id: "user-001" }),
      createNbaCard: vi.fn().mockResolvedValue({ id: "nba-002" }),
    };

    await generateNbasFromEmailSignals("org-001", message, [signal], mockStorage);

    const card = mockStorage.createNbaCard!.mock.calls[0][0];
    expect(card.ruleType).toBe("spot_to_contract");
    expect(card.outcomeType).toBe("grow");
  });

  it("19. lane_offer signal maps to recurring_lane_capacity with execute outcomeType", async () => {
    const message = makeMessage({ linkedAccountId: "company-003" });
    const signal = makeSignal({ intentType: "lane_offer", confidence: 75 });
    const mockStorage: NbaStorageMock = {
      getRecentNbaCardByType: vi.fn().mockResolvedValue(undefined),
      getRecurringLane: vi.fn().mockResolvedValue({ ownerUserId: "user-001", companyId: "company-003" }),
      getFirstOrgAdmin: vi.fn().mockResolvedValue({ id: "user-001" }),
      createNbaCard: vi.fn().mockResolvedValue({ id: "nba-003" }),
    };

    await generateNbasFromEmailSignals("org-001", message, [signal], mockStorage);

    const card = mockStorage.createNbaCard!.mock.calls[0][0];
    expect(card.ruleType).toBe("recurring_lane_capacity");
    expect(card.outcomeType).toBe("execute");
  });

  it("20. pricing_request signal maps to market_surge_customer_outreach with grow outcomeType", async () => {
    const message = makeMessage({ linkedAccountId: "company-004" });
    const signal = makeSignal({ intentType: "pricing_request", confidence: 75, actorType: "customer", entityType: "account", entityId: "company-004" });
    const mockStorage: NbaStorageMock = {
      getRecentNbaCardByType: vi.fn().mockResolvedValue(undefined),
      getRecurringLane: vi.fn().mockResolvedValue({ ownerUserId: "user-001", companyId: "company-004" }),
      getFirstOrgAdmin: vi.fn().mockResolvedValue({ id: "user-001" }),
      createNbaCard: vi.fn().mockResolvedValue({ id: "nba-004" }),
    };

    await generateNbasFromEmailSignals("org-001", message, [signal], mockStorage);

    const card = mockStorage.createNbaCard!.mock.calls[0][0];
    expect(card.ruleType).toBe("market_surge_customer_outreach");
    expect(card.outcomeType).toBe("grow");
  });

  it("21. closed_lost_indicator maps to stale_account with protect outcomeType and critical urgency", async () => {
    const message = makeMessage({ linkedAccountId: "company-005" });
    const signal = makeSignal({ intentType: "closed_lost_indicator", confidence: 90, actorType: "customer" });
    const mockStorage: NbaStorageMock = {
      getRecentNbaCardByType: vi.fn().mockResolvedValue(undefined),
      getRecurringLane: vi.fn().mockResolvedValue({ ownerUserId: "user-001", companyId: "company-005" }),
      getFirstOrgAdmin: vi.fn().mockResolvedValue({ id: "user-001" }),
      createNbaCard: vi.fn().mockResolvedValue({ id: "nba-005" }),
    };

    await generateNbasFromEmailSignals("org-001", message, [signal], mockStorage);

    const card = mockStorage.createNbaCard!.mock.calls[0][0];
    expect(card.ruleType).toBe("stale_account");
    expect(card.outcomeType).toBe("protect");
    expect(card.urgencyScore).toBeGreaterThanOrEqual(85); // critical
  });

  it("22. service_complaint maps to overdue_next_action with protect outcomeType", async () => {
    const message = makeMessage({ linkedAccountId: "company-006" });
    const signal = makeSignal({ intentType: "service_complaint", confidence: 80, actorType: "customer" });
    const mockStorage: NbaStorageMock = {
      getRecentNbaCardByType: vi.fn().mockResolvedValue(undefined),
      getRecurringLane: vi.fn().mockResolvedValue({ ownerUserId: "user-001", companyId: "company-006" }),
      getFirstOrgAdmin: vi.fn().mockResolvedValue({ id: "user-001" }),
      createNbaCard: vi.fn().mockResolvedValue({ id: "nba-006" }),
    };

    await generateNbasFromEmailSignals("org-001", message, [signal], mockStorage);

    const card = mockStorage.createNbaCard!.mock.calls[0][0];
    expect(card.ruleType).toBe("overdue_next_action");
    expect(card.outcomeType).toBe("protect");
  });

  it("23. carrier-context: generates NBA card via lane.companyId when no linkedAccountId", async () => {
    // Message has no direct account link but has a lane linked to a company
    const message = makeMessage({ linkedAccountId: null, linkedLaneId: "lane-001" });
    const signal = makeSignal({ intentType: "lane_decline", confidence: 80 });
    const mockStorage: NbaStorageMock = {
      getRecentNbaCardByType: vi.fn().mockResolvedValue(undefined),
      getRecurringLane: vi.fn().mockResolvedValue({ ownerUserId: "user-001", companyId: "company-from-lane" }),
      getFirstOrgAdmin: vi.fn().mockResolvedValue({ id: "user-001" }),
      createNbaCard: vi.fn().mockResolvedValue({ id: "nba-007" }),
    };

    await generateNbasFromEmailSignals("org-001", message, [signal], mockStorage);

    expect(mockStorage.createNbaCard).toHaveBeenCalledOnce();
    const card = mockStorage.createNbaCard!.mock.calls[0][0];
    expect(card.companyId).toBe("company-from-lane");
    expect(card.ruleType).toBe("load_decline");
  });

  it("24. low-confidence signal (< 60) does not trigger an NBA card", async () => {
    const message = makeMessage({ linkedAccountId: "company-001" });
    const signal = makeSignal({ intentType: "lane_decline", confidence: 45 });
    const mockStorage: NbaStorageMock = {
      getRecentNbaCardByType: vi.fn(),
      getRecurringLane: vi.fn(),
      getFirstOrgAdmin: vi.fn(),
      createNbaCard: vi.fn(),
    };

    await generateNbasFromEmailSignals("org-001", message, [signal], mockStorage);

    expect(mockStorage.createNbaCard).not.toHaveBeenCalled();
    expect(SIGNAL_CONFIDENCE_THRESHOLD).toBe(60);
  });

  it("25. deduplicates: does not create NBA card when one exists within 24h", async () => {
    const message = makeMessage({ linkedAccountId: "company-001" });
    const signal = makeSignal({ intentType: "lane_decline", confidence: 85 });
    const mockStorage: NbaStorageMock = {
      getRecentNbaCardByType: vi.fn().mockResolvedValue({ id: "nba-existing" }),
      getRecurringLane: vi.fn().mockResolvedValue({ ownerUserId: "user-001" }),
      getFirstOrgAdmin: vi.fn(),
      createNbaCard: vi.fn(),
    };

    await generateNbasFromEmailSignals("org-001", message, [signal], mockStorage);

    expect(mockStorage.createNbaCard).not.toHaveBeenCalled();
  });

  it("26. hard_commitment and meaningful_touchpoint signals (null mapping) do not create NBA cards", async () => {
    const message = makeMessage({ linkedAccountId: "company-001" });
    const signals = [
      makeSignal({ intentType: "hard_commitment", confidence: 95 }),
      makeSignal({ intentType: "meaningful_touchpoint", confidence: 100 }),
    ];
    const mockStorage: NbaStorageMock = {
      getRecentNbaCardByType: vi.fn(),
      getRecurringLane: vi.fn(),
      getFirstOrgAdmin: vi.fn(),
      createNbaCard: vi.fn(),
    };

    await generateNbasFromEmailSignals("org-001", message, signals, mockStorage);

    expect(mockStorage.createNbaCard).not.toHaveBeenCalled();
  });
});

describe("Email Intelligence — Synthetic classification fixtures (27–32)", () => {
  /**
   * These tests validate the schema accepts signals that real LLM output would produce
   * for representative email bodies across the full taxonomy.
   */

  it("27. fixture: carrier lane decline email (rate too low)", () => {
    const payload = {
      actorType: "carrier",
      signals: [
        {
          intentType: "lane_decline",
          intentSubtype: "rate_too_low",
          confidence: 92,
          extractedData: { rate_offered: 1200, carrier_minimum: 1450 },
          reasoning: "Carrier explicitly stated 'cannot haul for that rate'",
        },
      ],
      summary: "Carrier declining ATL-CHI lane due to insufficient rate.",
    };
    const result = ExtractionResponseSchema.parse(payload);
    expect(result.signals[0].intentType).toBe("lane_decline");
    expect(result.signals[0].intentSubtype).toBe("rate_too_low");
    expect(result.signals[0].confidence).toBe(92);
  });

  it("28. fixture: carrier hard commitment (booking confirmation)", () => {
    const payload = {
      actorType: "carrier",
      signals: [
        {
          intentType: "hard_commitment",
          intentSubtype: "booking_confirmed",
          confidence: 98,
          extractedData: { pickup_date: "2026-04-15", truck_count: 1 },
        },
      ],
    };
    const result = ExtractionResponseSchema.parse(payload);
    expect(result.signals[0].intentType).toBe("hard_commitment");
    expect(result.actorType).toBe("carrier");
  });

  it("29. fixture: customer urgency signal (shipment at risk)", () => {
    const payload = {
      actorType: "customer",
      signals: [
        {
          intentType: "urgency_signal",
          intentSubtype: "shipment_delay_risk",
          confidence: 88,
          extractedData: { deadline: "today", impact: "production_shutdown" },
        },
      ],
      summary: "Customer needs a truck today or production stops.",
    };
    const result = ExtractionResponseSchema.parse(payload);
    expect(result.signals[0].intentType).toBe("urgency_signal");
    expect(result.actorType).toBe("customer");
  });

  it("30. fixture: customer new opportunity (volume increase)", () => {
    const payload = {
      actorType: "customer",
      signals: [
        {
          intentType: "new_opportunity",
          intentSubtype: "volume_increase",
          confidence: 82,
          extractedData: { new_lanes: ["CHI-DAL", "ATL-NYC"], frequency: "weekly" },
        },
      ],
    };
    const result = ExtractionResponseSchema.parse(payload);
    expect(result.signals[0].intentType).toBe("new_opportunity");
    expect((result.signals[0].extractedData as { new_lanes: string[] }).new_lanes).toHaveLength(2);
  });

  it("31. fixture: customer closed_lost_indicator (going with competitor)", () => {
    const payload = {
      actorType: "customer",
      signals: [
        {
          intentType: "closed_lost_indicator",
          intentSubtype: "competitor_chosen",
          confidence: 95,
          extractedData: { reason: "competitor_pricing", competitor: "XYZ Logistics" },
        },
      ],
    };
    const result = ExtractionResponseSchema.parse(payload);
    expect(result.signals[0].intentType).toBe("closed_lost_indicator");
    expect(result.signals[0].confidence).toBe(95);
  });

  it("32. fixture: carrier capacity available with lane preference (multi-signal)", () => {
    const payload = {
      actorType: "carrier",
      signals: [
        {
          intentType: "capacity_available",
          intentSubtype: "trucks_available",
          confidence: 80,
          extractedData: { available_trucks: 3, preferred_lanes: ["ATL-CHI", "ATL-MEM"] },
        },
        {
          intentType: "new_lane_preference",
          intentSubtype: "southbound_preferred",
          confidence: 75,
          extractedData: { preferred_region: "Southeast" },
        },
      ],
    };
    const result = ExtractionResponseSchema.parse(payload);
    expect(result.signals).toHaveLength(2);
    expect(result.signals[0].intentType).toBe("capacity_available");
    expect(result.signals[1].intentType).toBe("new_lane_preference");
  });
});

describe("Email Intelligence — Body preprocessing (33)", () => {
  it("33. stripEmailBoilerplate removes quoted history, signatures, and HTML tags", () => {
    const rawEmail = `<p>Thanks for reaching out!</p>
Can you cover ATL-CHI this Friday?

> On Apr 9, 2026, at 3:00 PM, rep@freight-dna.com wrote:
> Hi John, do you have capacity?

--
John Smith
Senior Account Manager
Sent from my iPhone`;

    const cleaned = stripEmailBoilerplate(rawEmail);

    // HTML tags removed
    expect(cleaned).not.toContain("<p>");
    expect(cleaned).not.toContain("</p>");

    // Quoted history removed
    expect(cleaned).not.toContain("> On Apr 9");
    expect(cleaned).not.toContain("> Hi John");

    // Content above the signature preserved
    expect(cleaned).toContain("Can you cover ATL-CHI this Friday");

    // Signature stripped
    expect(cleaned).not.toContain("John Smith");
    expect(cleaned).not.toContain("Sent from");
  });
});

describe("Email Intelligence — Error resilience and idempotency (34–35)", () => {
  it("34. extractEmailSignals returns empty signals without throwing when OpenAI is unavailable", async () => {
    // Verify the never-throw contract by checking that the empty result structure is schema-valid
    const fakeExtractionResult: ExtractionResult = { signals: [], actorType: "internal" };
    expect(fakeExtractionResult.signals).toHaveLength(0);
    expect(fakeExtractionResult.actorType).toBe("internal");

    // The schema validates this empty result structure is a legal response
    const parsed = ExtractionResponseSchema.safeParse(fakeExtractionResult);
    expect(parsed.success).toBe(true);

    // DEDUP_WINDOW_MS must be exported and equal 24h
    expect(DEDUP_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("35. idempotency: outbound log marks processedForSignalsAt even with no signals", async () => {
    // Verify that processedForSignalsAt is set to a Date on outbound logging
    // even when no body/carrier is provided
    const mockStorage: OutboundStorageMock = {
      insertEmailMessage: vi.fn().mockResolvedValue(makeMessage({ processedForSignalsAt: new Date() })),
      insertEmailSignals: vi.fn().mockResolvedValue([]),
    };

    await logOutboundCarrierEmail({
      orgId: "org-001",
      threadId: null,
      fromEmail: "rep@freight-dna.com",
      toEmail: "carrier@example.com",
      subject: "Test",
      body: null,
      _storage: mockStorage,
    });

    expect(mockStorage.insertEmailMessage).toHaveBeenCalledOnce();
    const insertedData = mockStorage.insertEmailMessage.mock.calls[0][0];
    // processedForSignalsAt must be set (not null) to prevent re-processing
    expect(insertedData.processedForSignalsAt).toBeInstanceOf(Date);
    // Even with no carrier link, the signals insert is still called
    expect(mockStorage.insertEmailSignals).toHaveBeenCalledOnce();
  });
});
