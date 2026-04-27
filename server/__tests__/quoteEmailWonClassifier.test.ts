import { describe, it, expect } from "vitest";
import { isWonLanguage } from "../services/quoteEmailIngestion";

// Task #723 — pure regex classifier for "we got the load" email language.
// Unit-tested in isolation so we can iterate on the patterns without
// spinning up the inbound-email pipeline. The detector is intentionally
// high-precision; recall is owned by the upstream LLM intent classifier.

describe("isWonLanguage — positive cases", () => {
  const positives = [
    "you got it!",
    "You've got it",
    "you have got it — please send rate con",
    "Go ahead and book it",
    "go ahead book this",
    "Please cover the load at $2,400",
    "book it",
    "tender it to your driver",
    "we'll go with you on this one",
    "we are going with you",
    "we'll use you for this load",
    "going with you, send the rate con",
    "load is yours",
    "the load is covered with you",
    "you are covered for tomorrow's pickup",
    "you're booked",
    "you're tendered",
    "you're awarded the load",
    "Awarded to you — please confirm pickup ETA",
    "Confirmed, please book the load",
    "PO #ABC-12345",
    "PO# 99887",
    "p.o. # 12345-XX",
    "Rate confirmation attached",
    "Load confirmation enclosed",
  ];
  for (const phrase of positives) {
    it(`flags as won: ${JSON.stringify(phrase)}`, () => {
      expect(isWonLanguage(phrase)).toBe(true);
    });
  }
});

describe("isWonLanguage — negative cases (must not false-positive)", () => {
  const negatives = [
    // Decline / pass language
    "Thanks for the quote — going to pass on this one",
    "We'll use someone else this time",
    "Rate is too high, we found a cheaper carrier",
    "Going with a different carrier",
    // Polite acknowledgement that ISN'T a booking
    "Got your quote, thanks!",
    "Thanks for sending the quote",
    "We received your rate.",
    // Question / negotiation (still pending)
    "Can you do $2,200 instead?",
    "Are you available for Monday pickup?",
    // Empty / null / whitespace
    "",
    "   ",
  ];
  for (const phrase of negatives) {
    it(`does NOT flag: ${JSON.stringify(phrase)}`, () => {
      expect(isWonLanguage(phrase)).toBe(false);
    });
  }
  it("returns false for null", () => {
    expect(isWonLanguage(null)).toBe(false);
  });
  it("returns false for undefined", () => {
    expect(isWonLanguage(undefined)).toBe(false);
  });
});

describe("isWonLanguage — case insensitivity", () => {
  it("matches uppercase", () => {
    expect(isWonLanguage("YOU GOT IT")).toBe(true);
  });
  it("matches mixed case", () => {
    expect(isWonLanguage("Go Ahead And Book It")).toBe(true);
  });
});
