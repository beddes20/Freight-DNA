/**
 * Carrier Intel Suggestion Mapper — Test Suite (Task #193)
 *
 * Tests:
 *  1. lane_offer email signal creates lane_preference suggestion
 *  2. capacity_available email signal creates capacity_available suggestion
 *  3. price_pushback email signal creates price_sensitivity suggestion
 *  4. new_lane_preference maps to lane_preference
 *  5. service_issue maps to service_risk
 *  6. soft_commitment maps to lane_preference when lane data present
 *  7. hard_commitment maps to capacity_available when no lane data present (elevated confidence)
 *  8. Dedupe logic skips duplicate for same carrier + type + emailSignalId
 *  9. Skips already-accepted suggestion
 * 10. Non-carrier actorType signals are skipped
 * 11. Mapper failure does not throw (non-blocking)
 * 12. Unmapped intent (lane_decline) produces no suggestion
 */

import { describe, it, expect, vi } from "vitest";
import { processCarrierEmailSignals } from "../services/carrierIntelSuggestions";
import type { EmailSignal, EmailMessage, CarrierIntelSuggestion } from "@shared/schema";

function makeMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "msg-001",
    orgId: "org-001",
    threadId: "thread-abc",
    direction: "inbound",
    fromEmail: "carrier@example.com",
    toEmail: "rep@freight.com",
    ccEmail: null,
    subject: "Lane availability",
    body: "We can run that lane.",
    linkedAccountId: null,
    linkedCarrierId: "carrier-001",
    linkedLaneId: null,
    linkedLoadId: null,
    linkedTaskId: null,
    linkedNbaId: null,
    linkedOutreachLogId: null,
    processedForSignalsAt: null,
    createdAt: new Date("2026-04-10T10:00:00Z"),
    providerMessageId: null,
    ...overrides,
  };
}

function makeSignal(overrides: Partial<EmailSignal> = {}): EmailSignal {
  return {
    id: "sig-001",
    messageId: "msg-001",
    intentType: "lane_offer",
    intentSubtype: null,
    actorType: "carrier",
    entityType: "carrier",
    entityId: "carrier-001",
    confidence: 80,
    extractedData: { origin: "Atlanta", destination: "Chicago", equipment: "Dry Van" },
    createdAt: new Date("2026-04-10T10:00:00Z"),
    ...overrides,
  };
}

function makeStorageMock(opts: {
  duplicate?: CarrierIntelSuggestion | undefined;
} = {}) {
  return {
    findDuplicateSuggestion: vi.fn().mockResolvedValue(opts.duplicate ?? undefined),
    insertCarrierIntelSuggestion: vi.fn().mockResolvedValue({ id: "sugg-001" }),
  };
}

describe("Carrier Intel Suggestion Mapper (1–12)", () => {
  it("1. lane_offer signal creates a lane_preference suggestion", async () => {
    const storage = makeStorageMock();
    const signal = makeSignal({ intentType: "lane_offer" });
    await processCarrierEmailSignals(storage as any, "carrier-001", "org-001", makeMessage(), [signal]);
    expect(storage.insertCarrierIntelSuggestion).toHaveBeenCalledOnce();
    const inserted = storage.insertCarrierIntelSuggestion.mock.calls[0][0];
    expect(inserted.suggestionType).toBe("lane_preference");
    expect(inserted.carrierId).toBe("carrier-001");
    expect(inserted.orgId).toBe("org-001");
    expect(inserted.sourceType).toBe("email_signal");
    expect(inserted.emailSignalId).toBe("sig-001");
  });

  it("2. capacity_available signal creates a capacity_available suggestion", async () => {
    const storage = makeStorageMock();
    const signal = makeSignal({
      intentType: "capacity_available",
      extractedData: { region: "Midwest", available_date: "2026-04-15" },
    });
    await processCarrierEmailSignals(storage as any, "carrier-001", "org-001", makeMessage(), [signal]);
    expect(storage.insertCarrierIntelSuggestion).toHaveBeenCalledOnce();
    const inserted = storage.insertCarrierIntelSuggestion.mock.calls[0][0];
    expect(inserted.suggestionType).toBe("capacity_available");
    expect((inserted.payload as any).region).toBe("Midwest");
  });

  it("3. price_pushback signal creates a price_sensitivity suggestion", async () => {
    const storage = makeStorageMock();
    const signal = makeSignal({
      intentType: "price_pushback",
      extractedData: { rate: 1500, reason: "rate_too_low" },
    });
    await processCarrierEmailSignals(storage as any, "carrier-001", "org-001", makeMessage(), [signal]);
    expect(storage.insertCarrierIntelSuggestion).toHaveBeenCalledOnce();
    const inserted = storage.insertCarrierIntelSuggestion.mock.calls[0][0];
    expect(inserted.suggestionType).toBe("price_sensitivity");
    expect((inserted.payload as any).rate).toBe(1500);
  });

  it("4. new_lane_preference maps to lane_preference", async () => {
    const storage = makeStorageMock();
    const signal = makeSignal({ intentType: "new_lane_preference" });
    await processCarrierEmailSignals(storage as any, "carrier-001", "org-001", makeMessage(), [signal]);
    expect(storage.insertCarrierIntelSuggestion).toHaveBeenCalledOnce();
    const inserted = storage.insertCarrierIntelSuggestion.mock.calls[0][0];
    expect(inserted.suggestionType).toBe("lane_preference");
  });

  it("5. service_issue maps to service_risk", async () => {
    const storage = makeStorageMock();
    const signal = makeSignal({
      intentType: "service_issue",
      extractedData: { issueType: "late_pickup", severity: "high" },
    });
    await processCarrierEmailSignals(storage as any, "carrier-001", "org-001", makeMessage(), [signal]);
    expect(storage.insertCarrierIntelSuggestion).toHaveBeenCalledOnce();
    const inserted = storage.insertCarrierIntelSuggestion.mock.calls[0][0];
    expect(inserted.suggestionType).toBe("service_risk");
  });

  it("6. soft_commitment with lane data maps to lane_preference with elevated confidence", async () => {
    const storage = makeStorageMock();
    const signal = makeSignal({
      intentType: "soft_commitment",
      confidence: 70,
      extractedData: { origin: "Dallas", destination: "Memphis" },
    });
    await processCarrierEmailSignals(storage as any, "carrier-001", "org-001", makeMessage(), [signal]);
    expect(storage.insertCarrierIntelSuggestion).toHaveBeenCalledOnce();
    const inserted = storage.insertCarrierIntelSuggestion.mock.calls[0][0];
    expect(inserted.suggestionType).toBe("lane_preference");
    expect(inserted.confidenceScore).toBeGreaterThan(70);
  });

  it("7. hard_commitment without lane data maps to capacity_available with elevated confidence", async () => {
    const storage = makeStorageMock();
    const signal = makeSignal({
      intentType: "hard_commitment",
      confidence: 75,
      extractedData: { region: "Southeast" },
    });
    await processCarrierEmailSignals(storage as any, "carrier-001", "org-001", makeMessage(), [signal]);
    expect(storage.insertCarrierIntelSuggestion).toHaveBeenCalledOnce();
    const inserted = storage.insertCarrierIntelSuggestion.mock.calls[0][0];
    expect(inserted.suggestionType).toBe("capacity_available");
    expect(inserted.confidenceScore).toBeGreaterThan(75);
  });

  it("8. dedupe: does not insert if duplicate suggestion exists (same emailSignalId)", async () => {
    const existing = { id: "sugg-existing", status: "pending" } as CarrierIntelSuggestion;
    const storage = makeStorageMock({ duplicate: existing });
    const signal = makeSignal({ intentType: "lane_offer" });
    await processCarrierEmailSignals(storage as any, "carrier-001", "org-001", makeMessage(), [signal]);
    expect(storage.insertCarrierIntelSuggestion).not.toHaveBeenCalled();
  });

  it("9. dedupe: does not insert if duplicate is already accepted", async () => {
    const existing = { id: "sugg-existing", status: "accepted" } as CarrierIntelSuggestion;
    const storage = makeStorageMock({ duplicate: existing });
    const signal = makeSignal({ intentType: "lane_offer" });
    await processCarrierEmailSignals(storage as any, "carrier-001", "org-001", makeMessage(), [signal]);
    expect(storage.insertCarrierIntelSuggestion).not.toHaveBeenCalled();
  });

  it("10. non-carrier actorType signals are skipped", async () => {
    const storage = makeStorageMock();
    const signal = makeSignal({ intentType: "lane_offer", actorType: "customer" });
    await processCarrierEmailSignals(storage as any, "carrier-001", "org-001", makeMessage(), [signal]);
    expect(storage.insertCarrierIntelSuggestion).not.toHaveBeenCalled();
  });

  it("11. mapper failure does not throw (non-blocking) — storage error is swallowed", async () => {
    const storage = {
      findDuplicateSuggestion: vi.fn().mockRejectedValue(new Error("DB connection lost")),
      insertCarrierIntelSuggestion: vi.fn(),
    };
    const signal = makeSignal({ intentType: "lane_offer" });
    await expect(
      processCarrierEmailSignals(storage as any, "carrier-001", "org-001", makeMessage(), [signal])
    ).resolves.not.toThrow();
    expect(storage.insertCarrierIntelSuggestion).not.toHaveBeenCalled();
  });

  it("12. lane_decline intent produces no suggestion (unmapped)", async () => {
    const storage = makeStorageMock();
    const signal = makeSignal({ intentType: "lane_decline" });
    await processCarrierEmailSignals(storage as any, "carrier-001", "org-001", makeMessage(), [signal]);
    expect(storage.findDuplicateSuggestion).not.toHaveBeenCalled();
    expect(storage.insertCarrierIntelSuggestion).not.toHaveBeenCalled();
  });
});

// ─── Task #751 — loosened auto-accept gates ──────────────────────────────────
describe("Carrier Intel Suggestion Mapper — loosened auto-accept (Task #751)", () => {
  function makeAutoAcceptStorage() {
    return {
      findDuplicateSuggestion: vi.fn().mockResolvedValue(undefined),
      insertCarrierIntelSuggestion: vi.fn().mockResolvedValue({ id: "sugg-x" }),
      updateSuggestionStatus: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("auto-accepts equipment_capability from new_equipment_or_region intent", async () => {
    const storage = makeAutoAcceptStorage();
    const signal = makeSignal({
      intentType: "new_equipment_or_region",
      confidence: 80,
      extractedData: { equipment: "Reefer" },
    });
    await processCarrierEmailSignals(storage as any, "carrier-1", "org-1", makeMessage(), [signal]);
    expect(storage.insertCarrierIntelSuggestion).toHaveBeenCalledOnce();
    const inserted = storage.insertCarrierIntelSuggestion.mock.calls[0][0];
    expect(inserted.suggestionType).toBe("equipment_capability");
    expect(inserted.status).toBe("auto_accepted");
  });

  it("auto-accepts region_preference from new_equipment_or_region intent", async () => {
    const storage = makeAutoAcceptStorage();
    const signal = makeSignal({
      intentType: "new_equipment_or_region",
      confidence: 80,
      extractedData: { region: "Pacific Northwest" },
    });
    await processCarrierEmailSignals(storage as any, "carrier-1", "org-1", makeMessage(), [signal]);
    expect(storage.insertCarrierIntelSuggestion).toHaveBeenCalledOnce();
    const inserted = storage.insertCarrierIntelSuggestion.mock.calls[0][0];
    expect(inserted.suggestionType).toBe("region_preference");
    expect(inserted.status).toBe("auto_accepted");
  });

  it("auto-accepts capacity_unavailable (in AUTO_ACCEPT_TYPES)", async () => {
    const storage = makeAutoAcceptStorage();
    const signal = makeSignal({
      intentType: "capacity_unavailable",
      confidence: 85,
      extractedData: { region: "PNW" },
    });
    await processCarrierEmailSignals(storage as any, "carrier-1", "org-1", makeMessage(), [signal]);
    expect(storage.insertCarrierIntelSuggestion).toHaveBeenCalledOnce();
    const inserted = storage.insertCarrierIntelSuggestion.mock.calls[0][0];
    expect(inserted.status).toBe("auto_accepted");
  });

  it("price_sensitivity stays manual at confidence 80 (below very-high gate)", async () => {
    const storage = makeAutoAcceptStorage();
    const signal = makeSignal({
      intentType: "price_pushback",
      confidence: 80,
      extractedData: { rate: 2200, reason: "rate_too_low" },
    });
    await processCarrierEmailSignals(storage as any, "carrier-1", "org-1", makeMessage(), [signal]);
    expect(storage.insertCarrierIntelSuggestion).toHaveBeenCalledOnce();
    const inserted = storage.insertCarrierIntelSuggestion.mock.calls[0][0];
    expect(inserted.status).toBe("pending");
  });

  it("price_sensitivity auto-accepts at confidence 95 (very-high gate)", async () => {
    const storage = makeAutoAcceptStorage();
    const signal = makeSignal({
      intentType: "price_pushback",
      confidence: 95,
      extractedData: { rate: 2200, reason: "rate_too_low" },
    });
    await processCarrierEmailSignals(storage as any, "carrier-1", "org-1", makeMessage(), [signal]);
    expect(storage.insertCarrierIntelSuggestion).toHaveBeenCalledOnce();
    const inserted = storage.insertCarrierIntelSuggestion.mock.calls[0][0];
    expect(inserted.status).toBe("auto_accepted");
  });

  it("lane_preference auto-accepts when only origin is present (loosened)", async () => {
    const storage = makeAutoAcceptStorage();
    const signal = makeSignal({
      intentType: "lane_offer",
      confidence: 85,
      extractedData: { origin: "Atlanta" }, // no destination
    });
    await processCarrierEmailSignals(storage as any, "carrier-1", "org-1", makeMessage(), [signal]);
    expect(storage.insertCarrierIntelSuggestion).toHaveBeenCalledOnce();
    const inserted = storage.insertCarrierIntelSuggestion.mock.calls[0][0];
    expect(inserted.status).toBe("auto_accepted");
  });
});
