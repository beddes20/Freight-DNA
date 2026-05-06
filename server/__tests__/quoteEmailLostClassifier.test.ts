import { describe, it, expect } from "vitest";
import { isLostLanguage, decideLostReason, extractFirstLostMatch } from "../services/quoteEmailIngestion";

// Phrase-level Lost detector — mirrors quoteEmailWonClassifier.test.ts.
// The regex sweep is the safety net for when the upstream LLM intent
// classifier misses a `closed_lost_indicator`. High precision is required:
// each pattern must clearly say "we are not booking this with you" rather
// than negotiation, a question, or polite acknowledgement.

describe("isLostLanguage — positive cases", () => {
  const positives = [
    // Going with someone else
    "Thanks for the quote — we're going with another carrier",
    "going with someone else this time",
    "We are going with a different carrier on this one",
    "Going in a different direction, thanks though",
    // Pass / decline
    "We'll pass on this one",
    "Going to pass this round",
    "Gonna pass on this load",
    "We're not going to use you for this lane",
    "We won't book you on this one",
    "Will not tender you this load",
    "We'll have to decline this",
    // Already covered (by another)
    "Load is already covered by another carrier",
    "We've already got this with another carrier",
    "Already booked it with someone else",
    "Load is already booked by another carrier",
    "Load is already tendered with another carrier",
    "Load is already covered with another carrier",
    // Price-driven
    "Rate is too high",
    "Price is out of budget",
    "Quote is too high for us",
    "Found a cheaper rate elsewhere",
    "Got a lower price from another broker",
    "We're going with a cheaper carrier",
    // Cancelled / no longer needed
    "Load was cancelled",
    "Shipment was pulled",
    "Order is on hold",
    "Customer cancelled",
    "We no longer need this load",
    "Don't need the truck anymore",
    // Award elsewhere
    "Awarded to another carrier",
    "Tendered to a different broker",
  ];
  for (const phrase of positives) {
    it(`flags as lost: ${JSON.stringify(phrase)}`, () => {
      expect(isLostLanguage(phrase)).toBe(true);
    });
  }
});

describe("isLostLanguage — negative cases (must not false-positive)", () => {
  const negatives = [
    // Won language must NOT trip lost detector
    "you got it!",
    "go ahead and book it",
    "we're going with you on this",
    "load is covered with you",
    "you're awarded the load",
    // Polite acknowledgement
    "Thanks for the quote, we'll review",
    "Got your quote, will get back to you",
    "Received your rate",
    // Negotiation / question (still pending)
    "Can you do $2,200?",
    "Are you available for Monday pickup?",
    "Any chance you can match this rate?",
    // Asking about coverage availability (not declining)
    "Can you cover this load?",
    "Do you have a truck available?",
    // Empty / null
    "",
    "   ",
  ];
  for (const phrase of negatives) {
    it(`does NOT flag: ${JSON.stringify(phrase)}`, () => {
      expect(isLostLanguage(phrase)).toBe(false);
    });
  }
  it("returns false for null", () => {
    expect(isLostLanguage(null)).toBe(false);
  });
  it("returns false for undefined", () => {
    expect(isLostLanguage(undefined)).toBe(false);
  });
});

describe("isLostLanguage — case insensitivity", () => {
  it("matches uppercase", () => {
    expect(isLostLanguage("WE'RE GOING WITH ANOTHER CARRIER")).toBe(true);
  });
  it("matches mixed case", () => {
    expect(isLostLanguage("Found A Cheaper Rate Elsewhere")).toBe(true);
  });
});

// Regression: prior versions had broad patterns `\bcovered\s+already\b` and
// `\bload\s+is\s+(?:already\s+)?(?:booked|tendered)\b` with no
// external-party requirement. They false-positived on Won-adjacent phrases
// like "load is booked with you" and "covered already with you", which mean
// the OPPOSITE of Lost. These tests lock in the precision floor.
describe("isLostLanguage — Won-adjacent precision (regression)", () => {
  it("does NOT flip 'load is booked with you' to Lost", () => {
    expect(isLostLanguage("load is booked with you")).toBe(false);
  });
  it("does NOT flip 'load is already booked with you' to Lost", () => {
    expect(isLostLanguage("load is already booked with you")).toBe(false);
  });
  it("does NOT flip 'covered with us' to Lost", () => {
    expect(isLostLanguage("covered with us, thanks")).toBe(false);
  });
  it("does NOT flip 'tendered to you' to Lost", () => {
    expect(isLostLanguage("tendered to you — please confirm pickup")).toBe(false);
  });
  it("does NOT flip standalone 'covered already' to Lost (ambiguous, no external party)", () => {
    expect(isLostLanguage("Just FYI — covered already, will circle back next week.")).toBe(false);
  });
  it("DOES flip 'load is booked by another carrier' to Lost", () => {
    expect(isLostLanguage("load is booked by another carrier")).toBe(true);
  });
  it("DOES flip 'load is already covered with another' to Lost", () => {
    expect(isLostLanguage("load is already covered with another")).toBe(true);
  });
  it("DOES flip 'tendered elsewhere' to Lost", () => {
    expect(isLostLanguage("we got this tendered elsewhere — sorry")).toBe(true);
  });
});

describe("decideLostReason — phrase-derived classification", () => {
  it("maps cancelled / pulled language to lost_timing", () => {
    expect(decideLostReason("Load was cancelled")).toMatchObject({ code: "lost_timing" });
    expect(decideLostReason("Shipment was pulled")).toMatchObject({ code: "lost_timing" });
    expect(decideLostReason("No longer needed")).toMatchObject({ code: "lost_timing" });
  });
  it("maps price/cheaper language to lost_price", () => {
    expect(decideLostReason("Rate is too high")).toMatchObject({ code: "lost_price" });
    expect(decideLostReason("Found a cheaper carrier")).toMatchObject({ code: "lost_price" });
  });
  it("maps service/transit/equipment language to lost_service", () => {
    expect(decideLostReason("Service didn't fit our needs")).toMatchObject({ code: "lost_service" });
    expect(decideLostReason("Transit time too long")).toMatchObject({ code: "lost_service" });
  });
  it("defaults ambiguous loss language to lost_incumbent", () => {
    expect(decideLostReason("Going with someone else")).toMatchObject({ code: "lost_incumbent" });
    expect(decideLostReason("")).toMatchObject({ code: "lost_incumbent" });
    expect(decideLostReason(null)).toMatchObject({ code: "lost_incumbent" });
  });
});

describe("extractFirstLostMatch — surfaces the matched phrase", () => {
  it("returns the matched fragment for a positive body", () => {
    const m = extractFirstLostMatch("Hey thanks for the quote — going with another carrier on this one. Have a good week.");
    expect(m).toBeTruthy();
    expect((m ?? "").toLowerCase()).toContain("another");
  });
  it("returns null for non-matching text", () => {
    expect(extractFirstLostMatch("Thanks, will get back to you soon.")).toBeNull();
  });
  it("returns null for empty/null", () => {
    expect(extractFirstLostMatch("")).toBeNull();
    expect(extractFirstLostMatch(null)).toBeNull();
    expect(extractFirstLostMatch(undefined)).toBeNull();
  });
});
