/**
 * Spot Quote Create / Email Draft — Validation Test Suite (Task #516)
 *
 * Covers the contract layer the frontend QuoteBuilder card and the
 * `/api/customer-quotes/spot/create` and `/api/customer-quotes/spot/email-draft`
 * endpoints share via @shared/schema.
 *
 * Tests:
 *  1  spotQuoteCreateSchema accepts a well-formed payload
 *  2  spotQuoteCreateSchema rejects quotedAmount = 0 (guardrail integrity)
 *  3  spotQuoteCreateSchema rejects negative quotedAmount
 *  4  spotQuoteCreateSchema rejects missing customerId
 *  5  spotQuoteCreateSchema rejects malformed validUntil
 *  6  spotQuoteCreateSchema accepts an empty validUntil (literal "")
 *  7  spotQuoteCreateSchema accepts an absent estimatedCost (optional)
 *  8  Margin guardrail math: 20% margin (quoted 2500 / cost 2000) clears 5%
 *  9  Margin guardrail math: 4% margin (quoted 2500 / cost 2400) breaches 5%
 */

import { describe, it, expect } from "vitest";
import { spotQuoteCreateSchema } from "@shared/schema";

const okPayload = {
  customerId: "cust-1",
  equipment: "Van",
  pickupCity: "Chicago",
  pickupState: "IL",
  deliveryCity: "Atlanta",
  deliveryState: "GA",
  quotedAmount: 2500,
  estimatedCost: 2000,
  validUntil: "2026-12-31",
  notes: "first lane on this customer",
};

function marginPct(quoted: number, cost: number): number {
  return ((quoted - cost) / quoted) * 100;
}

describe("spotQuoteCreateSchema", () => {
  it("accepts a well-formed payload", () => {
    const r = spotQuoteCreateSchema.safeParse(okPayload);
    expect(r.success).toBe(true);
  });

  it("rejects quotedAmount = 0", () => {
    const r = spotQuoteCreateSchema.safeParse({ ...okPayload, quotedAmount: 0 });
    expect(r.success).toBe(false);
  });

  it("rejects negative quotedAmount", () => {
    const r = spotQuoteCreateSchema.safeParse({ ...okPayload, quotedAmount: -100 });
    expect(r.success).toBe(false);
  });

  it("rejects missing customerId", () => {
    const { customerId: _drop, ...rest } = okPayload;
    const r = spotQuoteCreateSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it("rejects malformed validUntil", () => {
    const r = spotQuoteCreateSchema.safeParse({ ...okPayload, validUntil: "12/31/2026" });
    expect(r.success).toBe(false);
  });

  it("accepts an empty validUntil literal", () => {
    const r = spotQuoteCreateSchema.safeParse({ ...okPayload, validUntil: "" });
    expect(r.success).toBe(true);
  });

  it("accepts an absent estimatedCost (optional)", () => {
    const { estimatedCost: _drop, ...rest } = okPayload;
    const r = spotQuoteCreateSchema.safeParse(rest);
    expect(r.success).toBe(true);
  });
});

describe("Margin guardrail math", () => {
  it("20% margin clears the 5% guardrail", () => {
    expect(marginPct(2500, 2000)).toBeGreaterThanOrEqual(5);
  });
  it("4% margin breaches the 5% guardrail", () => {
    expect(marginPct(2500, 2400)).toBeLessThan(5);
  });
});
