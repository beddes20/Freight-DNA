/**
 * Task #472 — freight_research tool unit tests.
 *
 * Covers:
 *   1. Intent classification (DOT/MC vs fuel vs general).
 *   2. Carrier-lookup gracefully reports "unknown" when no FMCSA key set.
 *   3. Fuel branch reports unknown when EIA returns null.
 *   4. General branch reports unknown when ANTHROPIC_API_KEY missing.
 *   5. Result shape always carries citations[] + usedProviders[] + unknown flag.
 *   6. Cache reuses confident answers and skips caching unknown ones.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the two real providers so the tests are deterministic & offline.
vi.mock("../sonarClient", () => ({
  getEiaDieselPrice: vi.fn(async () => null),
}));
vi.mock("../aiHelpers", () => ({
  getAnthropic: () => { throw new Error("not available in unit tests"); },
}));
vi.mock("../agent/openai", () => ({
  getAgentOpenAI: () => { throw new Error("not available in unit tests"); },
}));
// Stub global fetch so the Perplexity branch never makes a real network call.
const fetchMock = vi.fn(async () => new Response("", { status: 503 }));
vi.stubGlobal("fetch", fetchMock);

import {
  classifyIntent,
  freightResearch,
  _clearFreightResearchCache,
} from "../agent/freightResearch";
import { getEiaDieselPrice } from "../sonarClient";

beforeEach(() => {
  _clearFreightResearchCache();
  delete process.env.FMCSA_WEBKEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("", { status: 503 }));
  vi.mocked(getEiaDieselPrice).mockReset();
  vi.mocked(getEiaDieselPrice).mockResolvedValue(null);
});

describe("classifyIntent", () => {
  it("routes DOT/MC numbers to carrier_lookup", () => {
    expect(classifyIntent("Look up USDOT 123456")).toBe("carrier_lookup");
    expect(classifyIntent("MC-789012 safety record?")).toBe("carrier_lookup");
    expect(classifyIntent("dot #99999")).toBe("carrier_lookup");
  });
  it("routes fuel/diesel/FSC questions to fuel", () => {
    expect(classifyIntent("what's diesel doing?")).toBe("fuel");
    expect(classifyIntent("Current FSC formula")).toBe("fuel");
    expect(classifyIntent("national fuel surcharge")).toBe("fuel");
  });
  it("routes everything else to general", () => {
    expect(classifyIntent("How does the spot market look in TX?")).toBe("general");
    expect(classifyIntent("Reefer regulations for produce")).toBe("general");
  });
});

describe("freightResearch carrier_lookup", () => {
  it("reports unknown when no DOT/MC found in question", async () => {
    const r = await freightResearch("look up that carrier", "carrier_lookup");
    expect(r.intent).toBe("carrier_lookup");
    expect(r.unknown).toBe(true);
    expect(r.citations).toEqual([]);
    expect(r.usedProviders).toEqual([]);
  });
  it("reports unknown for MC numbers when no FMCSA key is configured", async () => {
    const r = await freightResearch("Pull MC 555555");
    expect(r.intent).toBe("carrier_lookup");
    expect(r.unknown).toBe(true);
    expect(r.answer).toMatch(/MC/);
  });
  it("reports unknown when FMCSA_WEBKEY not configured", async () => {
    const r = await freightResearch("USDOT 123456 status");
    expect(r.intent).toBe("carrier_lookup");
    expect(r.unknown).toBe(true);
    expect(r.usedProviders).toEqual(["fmcsa"]);
  });
});

describe("freightResearch fuel", () => {
  it("reports unknown when EIA returns null", async () => {
    const r = await freightResearch("what's national diesel?");
    expect(r.intent).toBe("fuel");
    expect(r.unknown).toBe(true);
    expect(r.usedProviders).toEqual(["eia"]);
    expect(r.answer.toLowerCase()).toMatch(/eia|diesel|unavailable/);
  });
  it("returns a confident answer with citation when EIA returns data", async () => {
    vi.mocked(getEiaDieselPrice).mockResolvedValueOnce({
      pricePerGal: 3.872,
      weekOverWeekDelta: -0.012,
      fetchedAt: Date.now(),
    });
    const r = await freightResearch("national diesel price?");
    expect(r.intent).toBe("fuel");
    expect(r.unknown).toBe(false);
    expect(r.answer).toContain("3.872");
    expect(r.citations.length).toBe(1);
    expect(r.citations[0].href).toMatch(/eia\.gov/);
  });
});

describe("freightResearch general path", () => {
  it("reports unknown when no provider keys are configured at all", async () => {
    const r = await freightResearch("How is the produce season shaping up?");
    expect(r.intent).toBe("general");
    expect(r.unknown).toBe(true);
    expect(r.usedProviders).toEqual([]);
    expect(r.citations).toEqual([]);
  });

  it("falls back to Perplexity-only answer with web citations when no LLM keys", async () => {
    process.env.PERPLEXITY_API_KEY = "test-key";
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "Produce season is ramping in McAllen and Nogales." } }],
      search_results: [{ title: "DAT Trendlines", url: "https://www.dat.com/blog" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const r = await freightResearch("Produce season outlook?");
    expect(r.intent).toBe("general");
    expect(r.unknown).toBe(false);
    expect(r.usedProviders).toContain("perplexity");
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.citations[0].href).toBe("https://www.dat.com/blog");
  });
});

describe("freightResearch result shape", () => {
  it("always exposes citations[], usedProviders[], unknown flag", async () => {
    const r = await freightResearch("USDOT 123456");
    expect(Array.isArray(r.citations)).toBe(true);
    expect(Array.isArray(r.usedProviders)).toBe(true);
    expect(typeof r.unknown).toBe("boolean");
    expect(typeof r.answer).toBe("string");
  });
});

describe("freightResearch cache", () => {
  it("reuses confident answers (one EIA call for repeated identical query)", async () => {
    vi.mocked(getEiaDieselPrice).mockResolvedValue({
      pricePerGal: 3.5, weekOverWeekDelta: 0.001, fetchedAt: Date.now(),
    });
    await freightResearch("diesel price now");
    await freightResearch("diesel price now");
    expect(vi.mocked(getEiaDieselPrice)).toHaveBeenCalledTimes(1);
  });
  it("does NOT cache unknown answers — retries on next call", async () => {
    vi.mocked(getEiaDieselPrice).mockResolvedValue(null);
    await freightResearch("diesel price now");
    await freightResearch("diesel price now");
    expect(vi.mocked(getEiaDieselPrice)).toHaveBeenCalledTimes(2);
  });
});
