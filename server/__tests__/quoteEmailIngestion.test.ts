import { describe, it, expect } from "vitest";
import { parseQuoteEmail } from "../services/quoteEmailIngestion";

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
