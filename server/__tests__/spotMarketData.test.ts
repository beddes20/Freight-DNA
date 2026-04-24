import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the kmaMapping helpers so we don't depend on the real lookup table.
vi.mock("../kmaMapping", () => ({
  cityToKma: (city: string, _state: string) => {
    if (!city) return null;
    if (city.toLowerCase() === "chicago") return { kma: "CHI" };
    if (city.toLowerCase() === "atlanta") return { kma: "ATL" };
    return { kma: city.slice(0, 3).toUpperCase() };
  },
  toTracEquipment: (raw: string | null | undefined): "VAN" | "REEFER" | "FLATBED" => {
    const s = (raw ?? "").toUpperCase();
    if (s.includes("REEF")) return "REEFER";
    if (s.includes("FLAT")) return "FLATBED";
    return "VAN";
  },
}));

const fetchFullLaneMock = vi.fn();
vi.mock("../tracService", () => ({
  fetchFullLane: (...args: unknown[]) => fetchFullLaneMock(...args),
}));

// Mock storage so importing the module doesn't try to connect to a DB.
vi.mock("../storage", () => ({ db: {} }));

import { getLaneMarket, __resetTracCacheForTests } from "../services/spotMarketData";

describe("spotMarketData.getLaneMarket — Task #515", () => {
  beforeEach(() => {
    __resetTracCacheForTests();
    fetchFullLaneMock.mockReset();
  });

  it("returns ok=false with a reason when TRAC throws and does NOT crash the caller", async () => {
    fetchFullLaneMock.mockRejectedValueOnce(new Error("503 upstream"));
    const r = await getLaneMarket("Chicago", "IL", "Atlanta", "GA", "Van");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/503|upstream/i);
  });

  it("caches the response for 1 hour — second call must NOT re-invoke TRAC", async () => {
    fetchFullLaneMock.mockResolvedValueOnce({
      spot: { rate: 1500, rateLow: 1400, rateHigh: 1700, rpm: 2.0, rpmLow: 1.8, rpmHigh: 2.3, miles: 720, confidenceScore: 80, totalLoadCount: 50 },
      contract: { contractRpm: 1.95 },
      stats: { avgRpm30d: 2.05, avgRpm90d: 2.0 },
      forecast: [{ forecastRpm: 2.1 }, { forecastRpm: 2.12 }, { forecastRpm: 2.15 }],
    });

    const a = await getLaneMarket("Chicago", "IL", "Atlanta", "GA", "Van");
    const b = await getLaneMarket("Chicago", "IL", "Atlanta", "GA", "Van");

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(fetchFullLaneMock).toHaveBeenCalledTimes(1);
  });

  it("derives forecast direction & capacity outlook from 7d forecast vs 30d baseline", async () => {
    fetchFullLaneMock.mockResolvedValueOnce({
      spot: { rate: 1500, rateLow: 1400, rateHigh: 1700, rpm: 2.0, rpmLow: 1.8, rpmHigh: 2.3, miles: 720, confidenceScore: 80, totalLoadCount: 50 },
      contract: { contractRpm: null },
      stats: { avgRpm30d: 2.0, avgRpm90d: 2.0 },
      // 7d forecast avg ~2.20 → ~+10% vs 30d baseline → "up"/"Tightening".
      forecast: Array.from({ length: 7 }, () => ({ forecastRpm: 2.2 })),
    });

    const r = await getLaneMarket("Chicago", "IL", "Atlanta", "GA", "Van");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.market.forecastDirection).toBe("up");
      expect(r.market.capacityOutlook).toMatch(/Tightening/);
    }
  });

  it("returns ok=false when KMA mapping fails for an endpoint", async () => {
    const r = await getLaneMarket("", "", "Atlanta", "GA", "Van");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/KMA/);
    expect(fetchFullLaneMock).not.toHaveBeenCalled();
  });
});
