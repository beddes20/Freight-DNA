import { describe, it, expect } from "vitest";
import {
  resolveLaneLocationWithConfidence,
  normalizeLaneLocationInput,
  getLaneLocationSuggestions,
  getCityAutocompleteSuggestions,
  formatCanonicalCityState,
  normalizeStateAbbr,
} from "../laneLocationNormalizer";

// ── formatCanonicalCityState ──────────────────────────────────────────────────

describe("formatCanonicalCityState", () => {
  it("returns City, ST format", () => {
    expect(formatCanonicalCityState("Phoenix", "AZ")).toBe("Phoenix, AZ");
  });

  it("handles multi-word cities", () => {
    expect(formatCanonicalCityState("Salt Lake City", "UT")).toBe("Salt Lake City, UT");
  });
});

// ── normalizeStateAbbr ────────────────────────────────────────────────────────

describe("normalizeStateAbbr", () => {
  it("uppercases a valid 2-letter state", () => {
    expect(normalizeStateAbbr("az")).toEqual({ abbr: "AZ", valid: true });
    expect(normalizeStateAbbr("tx")).toEqual({ abbr: "TX", valid: true });
  });

  it("converts full state name to abbreviation", () => {
    expect(normalizeStateAbbr("arizona")).toEqual({ abbr: "AZ", valid: true });
    expect(normalizeStateAbbr("Texas")).toEqual({ abbr: "TX", valid: true });
  });

  it("returns empty string as valid null abbr", () => {
    expect(normalizeStateAbbr("")).toEqual({ abbr: null, valid: true });
  });

  it("marks unrecognized states as invalid", () => {
    const result = normalizeStateAbbr("moo");
    expect(result.valid).toBe(false);
    expect(result.abbr).toBe("MOO");
  });
});

// ── normalizeLaneLocationInput ────────────────────────────────────────────────

describe("normalizeLaneLocationInput — formatting only", () => {
  it("collapses extra spaces around comma", () => {
    expect(normalizeLaneLocationInput("Phoenix ,  AZ")).toBe("Phoenix, AZ");
  });

  it("handles missing comma spacing", () => {
    expect(normalizeLaneLocationInput("phoenix,az")).toBe("Phoenix, AZ");
  });

  it("uppercases state from combined input", () => {
    expect(normalizeLaneLocationInput("dallas,tx")).toBe("Dallas, TX");
  });

  it("handles state passed separately", () => {
    expect(normalizeLaneLocationInput("memphis", "tn")).toBe("Memphis, TN");
  });

  it("handles all-caps city", () => {
    expect(normalizeLaneLocationInput("CHICAGO", "IL")).toBe("Chicago, IL");
  });

  it("title-cases multi-word cities", () => {
    expect(normalizeLaneLocationInput("salt lake city", "UT")).toBe("Salt Lake City, UT");
  });
});

// ── resolveLaneLocationWithConfidence ─────────────────────────────────────────

describe("resolveLaneLocationWithConfidence — exact matches (formatting only)", () => {
  it("returns exact for perfect input with just comma spacing fix", () => {
    const result = resolveLaneLocationWithConfidence("phoenix,az");
    expect(result.status).toBe("exact");
    expect(result.canonical).toBe("Phoenix, AZ");
    expect(result.city).toBe("Phoenix");
    expect(result.state).toBe("AZ");
  });

  it("returns exact for all-caps input", () => {
    const result = resolveLaneLocationWithConfidence("PHOENIX", "AZ");
    expect(result.status).toBe("exact");
    expect(result.canonical).toBe("Phoenix, AZ");
  });

  it("returns exact for properly formatted input", () => {
    const result = resolveLaneLocationWithConfidence("Dallas", "TX");
    expect(result.status).toBe("exact");
    expect(result.canonical).toBe("Dallas, TX");
  });
});

describe("resolveLaneLocationWithConfidence — typo correction (corrected)", () => {
  it("corrects pheonix, az → Phoenix, AZ (transposed letters)", () => {
    const result = resolveLaneLocationWithConfidence("pheonix", "az");
    expect(result.status).toBe("corrected");
    expect(result.canonical).toBe("Phoenix, AZ");
    expect(result.correctedFrom).toBeDefined();
  });

  it("corrects phoenx → Phoenix with state provided", () => {
    const result = resolveLaneLocationWithConfidence("phoenx", "AZ");
    expect(result.status).toBe("corrected");
    expect(result.canonical).toBe("Phoenix, AZ");
  });

  it("corrects memhis → Memphis with state provided", () => {
    const result = resolveLaneLocationWithConfidence("memhis", "TN");
    expect(result.status).toBe("corrected");
    expect(result.canonical).toBe("Memphis, TN");
  });

  it("corrects or suggests Dallas, TX for 'Dalles' (1 letter off)", () => {
    const result = resolveLaneLocationWithConfidence("Dalles", "TX");
    expect(["corrected", "suggested", "ambiguous"]).toContain(result.status);
    if (result.status === "corrected" || result.status === "suggested") {
      expect(result.canonical).toBe("Dallas, TX");
    } else {
      const candidateCities = (result.candidates ?? []).map(c => c.city);
      expect(candidateCities).toContain("Dallas");
    }
  });

  it("corrects houton → Houston, TX", () => {
    const result = resolveLaneLocationWithConfidence("houton", "TX");
    expect(result.status).toBe("corrected");
    expect(result.canonical).toBe("Houston, TX");
  });

  it("corrects seatle → Seattle, WA (single missing letter)", () => {
    const result = resolveLaneLocationWithConfidence("seatle", "WA");
    expect(result.status).toBe("corrected");
    expect(result.canonical).toBe("Seattle, WA");
  });
});

describe("resolveLaneLocationWithConfidence — medium confidence (suggested/ambiguous)", () => {
  it("returns ambiguous for city name with many matching states", () => {
    const result = resolveLaneLocationWithConfidence("Springfield");
    expect(["ambiguous", "suggested", "corrected", "exact"]).toContain(result.status);
    if (result.status === "ambiguous") {
      expect(result.candidates).toBeDefined();
      expect((result.candidates?.length ?? 0)).toBeGreaterThan(1);
    }
  });

  it("does not auto-correct when multiple states match equally", () => {
    const result = resolveLaneLocationWithConfidence("Columbus");
    expect(result.status !== "corrected" || (result.candidates ?? []).length <= 1).toBe(true);
  });
});

describe("resolveLaneLocationWithConfidence — invalid inputs", () => {
  it("returns invalid for completely unrecognizable city", () => {
    const result = resolveLaneLocationWithConfidence("Xyzzyburg", "TX");
    expect(result.status).toBe("invalid");
    expect(result.canonical).toBeNull();
  });

  it("returns invalid for gibberish input", () => {
    const result = resolveLaneLocationWithConfidence("aaaaaaaaaaaaa", "TX");
    expect(result.status).toBe("invalid");
  });

  it("returns invalid for invalid state code", () => {
    const result = resolveLaneLocationWithConfidence("Phoenix", "moo");
    expect(result.status).toBe("invalid");
    expect(result.canonical).toBeNull();
  });

  it("returns invalid for empty input", () => {
    const result = resolveLaneLocationWithConfidence("   ");
    expect(result.status).toBe("invalid");
  });

  it("does not invent a city for low-confidence input", () => {
    const result = resolveLaneLocationWithConfidence("Zanzibar", "TX");
    expect(result.status).toBe("invalid");
    expect(result.canonical).toBeNull();
  });
});

describe("resolveLaneLocationWithConfidence — canonical output format", () => {
  it("always outputs City, ST format on success", () => {
    const tests = [
      { city: "chicago", state: "il" },
      { city: "Houston", state: "TX" },
      { city: "salt lake city", state: "UT" },
    ];
    for (const { city, state } of tests) {
      const result = resolveLaneLocationWithConfidence(city, state);
      if (result.canonical) {
        expect(result.canonical).toMatch(/^[A-Z][a-zA-Z.\- ]+, [A-Z]{2}$/);
      }
    }
  });

  it("state abbreviation is always 2 uppercase letters", () => {
    const result = resolveLaneLocationWithConfidence("Austin", "TX");
    expect(result.state).toBe("TX");
    expect(result.canonical).toBe("Austin, TX");
  });
});

// ── getLaneLocationSuggestions ────────────────────────────────────────────────

describe("getLaneLocationSuggestions", () => {
  it("returns suggestions for a known city", () => {
    const suggestions = getLaneLocationSuggestions("Phoenix", "AZ");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].canonical).toBe("Phoenix, AZ");
  });

  it("returns fuzzy suggestions for typo", () => {
    const suggestions = getLaneLocationSuggestions("pheonix", "az");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].city).toBe("Phoenix");
  });

  it("respects maxResults", () => {
    const suggestions = getLaneLocationSuggestions("Springfield", undefined, 3);
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  it("each suggestion has city, state, and canonical", () => {
    const suggestions = getLaneLocationSuggestions("Dallas", "TX");
    for (const s of suggestions) {
      expect(s.city).toBeTruthy();
      expect(s.state).toBeTruthy();
      expect(s.canonical).toBe(`${s.city}, ${s.state}`);
    }
  });
});

// ── getCityAutocompleteSuggestions ────────────────────────────────────────────

describe("getCityAutocompleteSuggestions", () => {
  it("returns nothing for inputs shorter than 2 characters", () => {
    expect(getCityAutocompleteSuggestions("")).toEqual([]);
    expect(getCityAutocompleteSuggestions("p")).toEqual([]);
  });

  it("returns prefix matches for a partial city", () => {
    const suggestions = getCityAutocompleteSuggestions("phoe");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some(s => s.city === "Phoenix" && s.state === "AZ")).toBe(true);
    for (const s of suggestions) {
      expect(s.city.toLowerCase().startsWith("phoe")).toBe(true);
    }
  });

  it("filters by an explicit state", () => {
    const suggestions = getCityAutocompleteSuggestions("phoenix", "AZ");
    expect(suggestions.some(s => s.city === "Phoenix" && s.state === "AZ")).toBe(true);
    for (const s of suggestions) {
      expect(s.state).toBe("AZ");
    }
  });

  it("respects state typed inline after a comma", () => {
    const suggestions = getCityAutocompleteSuggestions("dallas, t");
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions) {
      expect(s.state.startsWith("T")).toBe(true);
      expect(s.city.toLowerCase().startsWith("dallas")).toBe(true);
    }
  });

  it("finds smaller cities by partial spelling (Millwood)", () => {
    const suggestions = getCityAutocompleteSuggestions("millw");
    expect(suggestions.some(s => s.city === "Millwood")).toBe(true);
  });

  it("returns canonical formatted as City, ST", () => {
    const suggestions = getCityAutocompleteSuggestions("austi", "TX");
    for (const s of suggestions) {
      expect(s.canonical).toBe(`${s.city}, ${s.state}`);
    }
  });

  it("respects maxResults", () => {
    const suggestions = getCityAutocompleteSuggestions("spring", undefined, 3);
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });
});
