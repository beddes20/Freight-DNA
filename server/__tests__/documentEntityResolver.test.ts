/**
 * Task #911 — documentEntityResolver pure-helper tests.
 *
 * The resolver itself talks to Drizzle, so DB-bound paths live in the
 * storage-integration workflow. Here we lock down the deterministic
 * helpers the resolver leans on:
 *   - `digitsOnly` strips MC#/DOT# prefixes & punctuation as documented.
 *   - `stripCorpSuffixes` removes common LLC/Inc/Trucking-style noise so
 *     fuzzy matches don't false-negative on "ACH Foods LLC" vs "ACH Foods, Inc.".
 *   - `nameSimilarity` (Sørensen-Dice bigrams) returns 1 for identical
 *     strings, ~0.9 for near-duplicates, < 0.55 for unrelated strings.
 *     This is the gate the carrier/customer fuzzy paths use.
 *
 * Drift in any of these silently breaks resolution — that is exactly
 * the kind of regression this file catches in unit-test time.
 */
import { describe, it, expect } from "vitest";
import { digitsOnly, stripCorpSuffixes, nameSimilarity } from "../services/documentEntityResolver";

describe("documentEntityResolver helpers (Task #911)", () => {
  describe("digitsOnly", () => {
    it("strips MC# prefix and punctuation", () => {
      expect(digitsOnly("MC# 123,456")).toBe("123456");
      expect(digitsOnly("MC-987654")).toBe("987654");
      expect(digitsOnly("DOT 1,234,567")).toBe("1234567");
    });
    it("returns empty string for null/undefined/empty", () => {
      expect(digitsOnly(null)).toBe("");
      expect(digitsOnly(undefined)).toBe("");
      expect(digitsOnly("")).toBe("");
      expect(digitsOnly("MC")).toBe(""); // no digits
    });
    it("preserves a numeric string verbatim", () => {
      expect(digitsOnly("123456")).toBe("123456");
    });
  });

  describe("stripCorpSuffixes", () => {
    it("removes LLC / Inc / Trucking / Logistics noise", () => {
      expect(stripCorpSuffixes("ACME Trucking LLC")).toBe("ACME");
      expect(stripCorpSuffixes("Allied Logistics, Inc.")).toBe("Allied");
      expect(stripCorpSuffixes("Big Red Transportation Co.")).toBe("Big Red");
      expect(stripCorpSuffixes("Crown Freight Lines")).toBe("Crown");
    });
    it("leaves a clean name untouched (modulo whitespace collapsing)", () => {
      expect(stripCorpSuffixes("ACH Foods")).toBe("ACH Foods");
    });
    it("collapses multiple spaces and punctuation introduced by the strip", () => {
      expect(stripCorpSuffixes("Smith & Sons, Inc.")).toBe("Smith Sons");
    });
    it("is case-insensitive on suffix removal", () => {
      expect(stripCorpSuffixes("DELTA INC")).toBe("DELTA");
      expect(stripCorpSuffixes("delta inc")).toBe("delta");
    });
  });

  describe("nameSimilarity (Sørensen-Dice bigrams)", () => {
    it("returns 1 for identical strings", () => {
      expect(nameSimilarity("acme trucking", "acme trucking")).toBe(1);
    });
    it("returns 0 for one or both empty inputs", () => {
      expect(nameSimilarity("", "anything")).toBe(0);
      expect(nameSimilarity("anything", "")).toBe(0);
      expect(nameSimilarity("", "")).toBe(0);
    });
    it("scores near-duplicates >= 0.85", () => {
      // "ACH Foods" vs "ACH Foods, Inc." after suffix strip — main fuzzy
      // path gets these.
      const a = stripCorpSuffixes("ACH FOODS LLC").toLowerCase();
      const b = stripCorpSuffixes("ACH Foods, Inc.").toLowerCase();
      expect(nameSimilarity(a, b)).toBeGreaterThanOrEqual(0.85);
    });
    it("rejects unrelated names with score < 0.55 (carrier fuzzy floor)", () => {
      expect(nameSimilarity("ach foods", "allied transport")).toBeLessThan(0.55);
      expect(nameSimilarity("acme trucking", "delta logistics")).toBeLessThan(0.55);
    });
    it("is symmetric", () => {
      const a = "acme trucking";
      const b = "acme trucks";
      expect(nameSimilarity(a, b)).toBeCloseTo(nameSimilarity(b, a), 6);
    });
    it("scores partial overlap meaningfully (0.4..0.85)", () => {
      const score = nameSimilarity("acme trucking", "acme transport");
      expect(score).toBeGreaterThan(0.4);
      expect(score).toBeLessThan(0.85);
    });
  });
});
