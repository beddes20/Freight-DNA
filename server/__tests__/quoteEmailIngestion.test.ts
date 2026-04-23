import { describe, it, expect } from "vitest";
import { parseQuoteEmail, decideLostReason } from "../services/quoteEmailIngestion";

describe("parseQuoteEmail", () => {
  it("extracts a basic city,ST → city,ST lane", () => {
    const out = parseQuoteEmail({
      subject: "Quote needed",
      body: "Need a rate from Chicago, IL to Atlanta, GA next Tuesday.",
    });
    expect(out).not.toBeNull();
    expect(out!.originCity).toBe("Chicago");
    expect(out!.originState).toBe("IL");
    expect(out!.destCity).toBe("Atlanta");
    expect(out!.destState).toBe("GA");
    expect(out!.equipment).toBe("Dry Van");
  });

  it("detects reefer equipment", () => {
    const out = parseQuoteEmail({
      subject: "Reefer rate",
      body: "Looking for reefer capacity Portland, OR to Los Angeles, CA.",
    });
    expect(out!.equipment).toBe("Reefer");
  });

  it("detects flatbed equipment", () => {
    const out = parseQuoteEmail({
      subject: "",
      body: "Flatbed load Dallas, TX to Newark, NJ — pickup tomorrow.",
    });
    expect(out!.equipment).toBe("Flatbed");
  });

  it("parses a target rate when present", () => {
    const out = parseQuoteEmail({
      subject: "RFQ",
      body: "Memphis, TN to St Louis, MO target $1,850 firm.",
    });
    expect(out!.quotedAmount).toBe(1850);
  });

  it("supports arrow lane format", () => {
    const out = parseQuoteEmail({
      subject: "Spot quote",
      body: "Lane: Houston, TX -> Boston, MA",
    });
    expect(out!.originCity).toBe("Houston");
    expect(out!.destCity).toBe("Boston");
  });

  it("returns null for emails without a recognizable lane", () => {
    expect(parseQuoteEmail({ subject: "Hello", body: "Just checking in." })).toBeNull();
    expect(parseQuoteEmail({ subject: "", body: "" })).toBeNull();
  });

  it("rejects implausible rates", () => {
    const out = parseQuoteEmail({
      subject: "",
      body: "Chicago, IL to Atlanta, GA — invoice #5",
    });
    expect(out!.quotedAmount).toBeNull();
  });
});

describe("decideLostReason (Task #482)", () => {
  it("defaults to lost_incumbent for empty / null language", () => {
    expect(decideLostReason(null).code).toBe("lost_incumbent");
    expect(decideLostReason("").code).toBe("lost_incumbent");
    expect(decideLostReason(undefined).code).toBe("lost_incumbent");
  });

  it("maps 'load is covered' style replies to lost_incumbent", () => {
    expect(decideLostReason("load is covered").code).toBe("lost_incumbent");
    expect(decideLostReason("we're covered, thanks").code).toBe("lost_incumbent");
    expect(decideLostReason("went with another carrier").code).toBe("lost_incumbent");
  });

  it("maps cancellation language to lost_timing", () => {
    expect(decideLostReason("load cancelled").code).toBe("lost_timing");
    expect(decideLostReason("no longer needed").code).toBe("lost_timing");
    expect(decideLostReason("customer pulled the freight").code).toBe("lost_timing");
  });

  it("maps price-driven losses to lost_price", () => {
    expect(decideLostReason("rate is too high").code).toBe("lost_price");
    expect(decideLostReason("found cheaper coverage").code).toBe("lost_price");
  });

  it("maps service / fit losses to lost_service", () => {
    expect(decideLostReason("transit time doesn't fit").code).toBe("lost_service");
    expect(decideLostReason("equipment isn't right").code).toBe("lost_service");
  });

  it("returns a status that matches the reason code", () => {
    for (const phrase of ["load is covered", "load cancelled", "rate is too high", "transit fit issue"]) {
      const r = decideLostReason(phrase);
      expect(r.status).toBe(r.code);
    }
  });
});
