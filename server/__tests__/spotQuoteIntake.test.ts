/**
 * Spot Quote Intake — messy real-world emails (Task #624).
 *
 * Task #617 ships with a single happy-path e2e test (paste a clean body and
 * verify the lane fields populate). Real broker mail is much grubbier:
 * forwarded headers, "On Mon, Apr 24, 2026 at..." quote chains, signatures
 * carrying a city/state from the rep's office, multi-lane requests, ALL-CAPS
 * forwarded subjects, and screenshots dropped into the dropzone.
 *
 * This suite covers those shapes against the real heuristic-based parser used
 * by `parseQuoteIntakeFromText` and a vision-mocked `parseQuoteIntakeFromImage`,
 * so a regression in the parser is caught before reps see it.
 */

import { afterEach, beforeAll, describe, it, expect, vi } from "vitest";

// ─── OpenAI stub ────────────────────────────────────────────────────────────
// `parseQuoteIntakeFromImage` instantiates the OpenAI client at first call and
// caches it module-side. Stub the module BEFORE we import the service so the
// cached client is the mock, and so the heuristic-only text tests can't
// accidentally hit the network if the heuristic ever returns null.

const visionResponse = vi.hoisted(() => ({
  current: "{}",
}));
const openaiCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("openai", () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: vi.fn(async () => {
          openaiCalls.count++;
          return { choices: [{ message: { content: visionResponse.current } }] };
        }),
      },
    };
  }
  return { default: MockOpenAI };
});

// `parseQuoteIntakeFromImage` short-circuits when OPENAI_API_KEY isn't set, so
// give it a sentinel value before the module is loaded.
beforeAll(() => {
  process.env.OPENAI_API_KEY = "test-key";
});

const { parseQuoteIntakeFromText, parseQuoteIntakeFromImage } = await import(
  "../services/spotQuoteIntake"
);

afterEach(() => {
  openaiCalls.count = 0;
});

// ─── Text intake — messy real-world bodies ──────────────────────────────────

describe("parseQuoteIntakeFromText — messy real-world emails", () => {
  it("ignores Outlook quoted-reply chains and parses the lane in the new content", async () => {
    const out = await parseQuoteIntakeFromText({
      subject: "Re: Spot quote",
      body: [
        "Need a rate from Chicago, IL → Atlanta, GA pickup Tuesday.",
        "",
        "On Mon, Apr 20, 2026 at 8:14 AM, Old Sender <old@x.com> wrote:",
        "> The original lane was Dallas, TX → Houston, TX — please ignore.",
        "> Also Newark, NJ → Boston, MA was an older request.",
      ].join("\n"),
    });
    expect(out.pickupCity).toBe("Chicago");
    expect(out.pickupState).toBe("IL");
    expect(out.deliveryCity).toBe("Atlanta");
    expect(out.deliveryState).toBe("GA");
    // The quoted history must NOT win.
    expect(out.pickupCity).not.toBe("Dallas");
    expect(out.deliveryCity).not.toBe("Houston");
    expect(out.confidence).toBeGreaterThanOrEqual(0.8);
    // No AI fallback should run when the heuristic succeeds.
    expect(openaiCalls.count).toBe(0);
  });

  it("does not let a signature address poison the destination lane", async () => {
    const out = await parseQuoteIntakeFromText({
      subject: "Spot rate needed",
      body: [
        "Hi team —",
        "",
        "Please quote: Chicago, IL → Atlanta, GA, dry van.",
        "",
        "Thanks,",
        "Jane Smith",
        "Logistics Coordinator | Acme Co",
        "123 Main St, Memphis, TN 38103",
        "(901) 555-1212 | jane@acmeco.com",
      ].join("\n"),
    });
    expect(out.pickupCity).toBe("Chicago");
    expect(out.pickupState).toBe("IL");
    expect(out.deliveryCity).toBe("Atlanta");
    expect(out.deliveryState).toBe("GA");
    // The Memphis, TN line in the signature must NOT poison the lane.
    expect(out.pickupCity).not.toBe("Memphis");
    expect(out.deliveryState).not.toBe("TN");
  });

  it("picks the FIRST lane in a multi-lane email and keeps confidence high", async () => {
    const out = await parseQuoteIntakeFromText({
      subject: "Multiple loads",
      body: [
        "Hey, please send rates on the following lanes today:",
        "1) Chicago, IL → Atlanta, GA — dry van pickup 4/30",
        "2) Dallas, TX → Houston, TX — reefer pickup 5/1",
        "3) Newark, NJ → Boston, MA — dry van pickup 5/2",
      ].join("\n"),
    });
    expect(out.pickupCity).toBe("Chicago");
    expect(out.pickupState).toBe("IL");
    expect(out.deliveryCity).toBe("Atlanta");
    expect(out.deliveryState).toBe("GA");
    expect(out.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("detects reefer equipment and a target rate buried in the body", async () => {
    const out = await parseQuoteIntakeFromText({
      subject: "RFQ",
      body: [
        "Memphis, TN to St Louis, MO — looking for reefer capacity.",
        "Target around $1,950 firm if possible. Pickup tomorrow AM.",
      ].join("\n"),
    });
    expect(out.pickupCity).toBe("Memphis");
    expect(out.deliveryCity).toBe("St Louis");
    expect(out.equipment).toBe("Reefer");
    expect(out.rateHint).toBe(1950);
  });

  it("strips Fwd:/Re: prefixes when guessing the customer hint from a forwarded subject", async () => {
    const out = await parseQuoteIntakeFromText({
      subject: "Fwd: Quote from Acme Logistics — CHI to ATL",
      body: "Need a rate Chicago, IL → Atlanta, GA next Tuesday.",
    });
    expect(out.customerHint).toBe("Acme Logistics");
    // Lane should still come from the body, not the truncated subject.
    expect(out.pickupCity).toBe("Chicago");
    expect(out.deliveryCity).toBe("Atlanta");
  });

  it("extracts the customer hint from a forwarded From: header (the original sender, not the rep who forwarded it)", async () => {
    const out = await parseQuoteIntakeFromText({
      subject: "FYI — please quote",
      body: [
        "---------- Forwarded message ---------",
        "From: Pat Customer <pat@bigshipper.com>",
        "Date: Thu, Apr 23, 2026 at 9:00 AM",
        "Subject: Quote needed",
        "",
        "Need a rate Chicago, IL to Atlanta, GA — pickup Tuesday.",
      ].join("\n"),
    });
    expect(out.customerHint).toBe("Pat Customer");
    expect(out.pickupCity).toBe("Chicago");
    expect(out.deliveryCity).toBe("Atlanta");
  });

  it("parses an ALL-CAPS body lane in the uppercase blob format ('DALLAS TX MIAMI FL')", async () => {
    const out = await parseQuoteIntakeFromText({
      subject: "FW: SPOT QUOTE NEEDED",
      body: "DALLAS TX MIAMI FL DRY VAN PICKUP TOMORROW",
    });
    expect(out.pickupCity).toBe("Dallas");
    expect(out.pickupState).toBe("TX");
    expect(out.deliveryCity).toBe("Miami");
    expect(out.deliveryState).toBe("FL");
  });

  it("returns confidence=0 with a friendly note when no lane is found", async () => {
    const out = await parseQuoteIntakeFromText({
      subject: "Hi",
      body: "Just checking in, no lane info here.",
    });
    expect(out.confidence).toBe(0);
    expect(out.pickupCity).toBeNull();
    expect(out.deliveryCity).toBeNull();
    expect(out.notes.length).toBeGreaterThan(0);
    expect(out.notes.join(" ")).toMatch(/no lane/i);
  });

  it("accepts a raw .eml blob (headers + body) and extracts subject/lane/source", async () => {
    const eml = [
      "From: Pat <pat@acme.com>",
      "To: rep@us.com",
      "Subject: Spot quote",
      "Date: Thu, 23 Apr 2026 10:00:00 +0000",
      "",
      "Lane: Chicago, IL → Atlanta, GA, dry van.",
    ].join("\r\n");

    const out = await parseQuoteIntakeFromText({ rawText: eml, source: "email" });
    expect(out.pickupCity).toBe("Chicago");
    expect(out.pickupState).toBe("IL");
    expect(out.deliveryCity).toBe("Atlanta");
    expect(out.deliveryState).toBe("GA");
    expect(out.equipment).toBe("Dry Van");
    expect(out.source).toBe("email");
  });
});

// ─── Image intake — vision-mocked screenshot ────────────────────────────────

describe("parseQuoteIntakeFromImage — vision-mocked screenshot", () => {
  it("returns the parsed lane from a mocked vision response", async () => {
    visionResponse.current = JSON.stringify({
      isQuote: true,
      pickupCity: "Chicago",
      pickupState: "IL",
      deliveryCity: "Atlanta",
      deliveryState: "GA",
      equipment: "Dry Van",
      pickupDate: "2026-04-30",
      rateHint: 2400,
      customerHint: "Acme Logistics",
      rawText: "Email screenshot — CHI to ATL request.",
    });

    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // tiny PNG header
    const out = await parseQuoteIntakeFromImage(buf, "image/png");

    expect(out.pickupCity).toBe("Chicago");
    expect(out.pickupState).toBe("IL");
    expect(out.deliveryCity).toBe("Atlanta");
    expect(out.deliveryState).toBe("GA");
    expect(out.equipment).toBe("Dry Van");
    expect(out.pickupDate).toBe("2026-04-30");
    expect(out.rateHint).toBe(2400);
    expect(out.customerHint).toBe("Acme Logistics");
    expect(out.confidence).toBeGreaterThan(0.8);
    expect(out.source).toBe("image");
    expect(out.rawText).toContain("CHI to ATL");
    expect(openaiCalls.count).toBe(1);
  });

  it("returns a friendly note when the vision model says it's not a quote", async () => {
    visionResponse.current = JSON.stringify({
      isQuote: false,
      pickupCity: null, pickupState: null,
      deliveryCity: null, deliveryState: null,
      equipment: null, pickupDate: null,
      rateHint: null, customerHint: null,
      rawText: "Looks like a shipping label, not a quote.",
    });

    const out = await parseQuoteIntakeFromImage(Buffer.from("notaquote"), "image/png");
    expect(out.pickupCity).toBeNull();
    expect(out.deliveryCity).toBeNull();
    expect(out.confidence).toBe(0);
    expect(out.notes.join(" ")).toMatch(/doesn't look like/i);
    expect(out.rawText).toContain("shipping label");
    expect(openaiCalls.count).toBe(1);
  });

  it("rejects images larger than the 8 MB cap WITHOUT calling the vision model", async () => {
    const big = Buffer.alloc(9 * 1024 * 1024); // 9 MB > 8 MB cap
    const out = await parseQuoteIntakeFromImage(big, "image/png");
    expect(out.pickupCity).toBeNull();
    expect(out.notes.join(" ")).toMatch(/too large|under 8 mb/i);
    expect(openaiCalls.count).toBe(0);
  });

  it("returns a 'couldn't pin down a full lane' note when vision returns partial fields", async () => {
    visionResponse.current = JSON.stringify({
      isQuote: true,
      pickupCity: "Chicago",
      pickupState: "IL",
      deliveryCity: null,
      deliveryState: null,
      equipment: "Dry Van",
      pickupDate: null,
      rateHint: null,
      customerHint: null,
      rawText: "Partial screenshot.",
    });

    const out = await parseQuoteIntakeFromImage(Buffer.from("partial"), "image/png");
    expect(out.pickupCity).toBe("Chicago");
    expect(out.deliveryCity).toBeNull();
    expect(out.notes.join(" ")).toMatch(/couldn't pin down a full lane/i);
  });
});
