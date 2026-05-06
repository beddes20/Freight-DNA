/**
 * Display-contract regression suite for the Conversations list (Task #940).
 *
 * The Conversations list and detail pane were leaking raw Outlook
 * conversation IDs (e.g. `AAQkAD…`) into the visible subject column and
 * letting "CAUTION: external email" banners + quoted-reply chains bleed
 * into the preview snippet. These tests pin the new shared helpers
 * (`resolveThreadSubject`, `resolvePreviewSnippet`) — the single source of
 * truth used by `thread-row.tsx` and `thread-detail-pane.tsx` — to the
 * documented contract so the regression can't return.
 *
 * Lives under server/__tests__/ because the helpers are pure and the
 * project's vitest config only includes `server/__tests__` and
 * `client/src/lib/__tests__` — adding a new test root would be a wider
 * config change than this task warrants.
 */

import { describe, it, expect } from "vitest";
import {
  resolveThreadSubject,
  resolvePreviewSnippet,
  looksLikeProviderId,
} from "@/components/conversations/utils";

// ════════════════════════════════════════════════════════════════════════
// resolveThreadSubject
// ════════════════════════════════════════════════════════════════════════

describe("resolveThreadSubject", () => {
  it("returns a normal subject untouched (whitespace trimmed)", () => {
    const subject = resolveThreadSubject({
      messages: [{ subject: "  Quote for lane 123  " }],
    });
    expect(subject).toBe("Quote for lane 123");
  });

  it("collapses Re: Re: Fwd: chains into a single Re: prefix", () => {
    const subject = resolveThreadSubject({
      messages: [{ subject: "Re: Re: Fwd: Quote for lane 123" }],
    });
    expect(subject).toBe("Re: Quote for lane 123");
  });

  it("collapses a forward-only chain to a single Re: prefix", () => {
    // A forwarded thread still gets `Re:` because the rep is reading it from
    // their inbox. The body normalization is the same code path either way.
    const subject = resolveThreadSubject({
      messages: [{ subject: "Fwd: FW: Fwd: Booking confirmation #88421" }],
    });
    expect(subject).toBe("Re: Booking confirmation #88421");
  });

  it("collapses internal whitespace inside the surviving subject", () => {
    const subject = resolveThreadSubject({
      messages: [{ subject: "Re:   Re:   Quote   for    lane" }],
    });
    expect(subject).toBe("Re: Quote for lane");
  });

  it("returns (no subject) when every message has a null/empty subject", () => {
    const subject = resolveThreadSubject({
      messages: [{ subject: null }, { subject: "" }, { subject: "   " }],
    });
    expect(subject).toBe("(no subject)");
  });

  it("returns (no subject) when the messages array is empty", () => {
    expect(resolveThreadSubject({ messages: [] })).toBe("(no subject)");
  });

  it("returns (no subject) when messages is null/undefined", () => {
    expect(resolveThreadSubject({ messages: null })).toBe("(no subject)");
    expect(resolveThreadSubject({ messages: undefined })).toBe("(no subject)");
  });

  it("rejects an Outlook-style provider id as the only subject candidate", () => {
    // This is the regression: the previous fallback dumped this kind of token
    // straight into the row title.
    const subject = resolveThreadSubject({
      messages: [{
        subject:
          "AAQkADk0YzM5OWE2LTBmZmYtNDk5Yi1iZjc1LWUxYTViNjQ4OTk2YQAQAA==",
      }],
    });
    expect(subject).toBe("(no subject)");
  });

  it("skips a provider-id subject and uses the next real one", () => {
    // Mixed-message thread where one message subject got mangled to an id
    // (occasionally happens when an inbound capture races with a missing
    // subject header). We pick the latest *real* subject.
    const subject = resolveThreadSubject({
      messages: [
        { subject: "Quote for lane 9" },
        { subject: "AAQkADmZmM2Q5MzMtZGE3Yi00YTQ4LWE5YzAtZmE3" },
      ],
    });
    expect(subject).toBe("Quote for lane 9");
  });

  it("scans latest -> earliest so the most recent subject wins", () => {
    // Server returns messages ascending; the latest is at the end. The
    // helper should prefer the latest non-empty, non-id subject.
    const subject = resolveThreadSubject({
      messages: [
        { subject: "Initial inquiry" },
        { subject: "Re: Initial inquiry" },
        { subject: "Re: Re: Initial inquiry" },
      ],
    });
    expect(subject).toBe("Re: Initial inquiry");
  });

  it("never returns the threadHint when it looks like a provider id", () => {
    // Defensive: even if a caller wires a hint that turns out to be the
    // raw threadId, the helper must reject it instead of leaking the token.
    const subject = resolveThreadSubject({
      messages: [],
      threadHint: "AAQkADk0YzM5OWE2LTBmZmYtNDk5Yi1iZjc1LWUxYTViNjQ4OTk2YQAQAA==",
    });
    expect(subject).toBe("(no subject)");
  });

  it("uses a real threadHint when no message has a usable subject", () => {
    const subject = resolveThreadSubject({
      messages: [{ subject: null }],
      threadHint: "Re: Quote for lane 7",
    });
    expect(subject).toBe("Re: Quote for lane 7");
  });

  it("normalizes a German-style Aw:/Wg: chain into Re:", () => {
    const subject = resolveThreadSubject({
      messages: [{ subject: "AW: WG: Anfrage Spedition" }],
    });
    expect(subject).toBe("Re: Anfrage Spedition");
  });
});

// ════════════════════════════════════════════════════════════════════════
// looksLikeProviderId
// ════════════════════════════════════════════════════════════════════════

describe("looksLikeProviderId", () => {
  it("flags Outlook AAQkAD… tokens", () => {
    expect(looksLikeProviderId("AAQkADk0YzM5OWE2LTBmZmYtNDk5Yi1iZjc1LWUxYTU=")).toBe(true);
  });

  it("flags long no-whitespace base64-ish tokens", () => {
    expect(looksLikeProviderId("a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6")).toBe(true);
  });

  it("does not flag normal subjects with spaces", () => {
    expect(looksLikeProviderId("Quote for a really long lane that runs from origin to destination plus extra")).toBe(false);
  });

  it("does not flag short tokens", () => {
    expect(looksLikeProviderId("ABC123")).toBe(false);
  });

  it("handles null/empty input safely", () => {
    expect(looksLikeProviderId(null)).toBe(false);
    expect(looksLikeProviderId(undefined)).toBe(false);
    expect(looksLikeProviderId("")).toBe(false);
    expect(looksLikeProviderId("   ")).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// resolvePreviewSnippet
// ════════════════════════════════════════════════════════════════════════

describe("resolvePreviewSnippet", () => {
  it("returns an empty string for null/empty bodies", () => {
    expect(resolvePreviewSnippet(null)).toBe("");
    expect(resolvePreviewSnippet("")).toBe("");
    expect(resolvePreviewSnippet("   ")).toBe("");
  });

  it("strips HTML and collapses whitespace", () => {
    const out = resolvePreviewSnippet(
      "<p>Hi team,</p>\n<p>Can you  send the   <b>rate</b>?</p>",
    );
    expect(out).toBe("Hi team, Can you send the rate?");
  });

  it("strips a leading CAUTION banner (single sentence)", () => {
    const body = "CAUTION: This email originated from outside the organization. Hi John, the load is booked, see you Monday.";
    const out = resolvePreviewSnippet(body);
    expect(out).not.toMatch(/caution/i);
    expect(out).not.toMatch(/originated/i);
    expect(out.startsWith("Hi John")).toBe(true);
  });

  it("strips a bracketed [EXTERNAL] banner", () => {
    const body = "[EXTERNAL] Hey, here is the BOL for tomorrow.";
    const out = resolvePreviewSnippet(body);
    expect(out).toBe("Hey, here is the BOL for tomorrow.");
  });

  it("strips a multi-line caution + 'Do not click' banner pair", () => {
    const body = [
      "CAUTION: This message came from outside your organization.",
      "Do not click links or open attachments unless you recognize the sender.",
      "Driver is at the gate, ready to load.",
    ].join("\n");
    const out = resolvePreviewSnippet(body);
    expect(out).toBe("Driver is at the gate, ready to load.");
  });

  it("strips a 6-line confidentiality disclaimer footer", () => {
    const body = [
      "Quote for lane 123 attached.",
      "",
      "This email and any attachments are confidential and intended solely for the use of the intended recipient.",
      "If you are not the intended recipient, please notify the sender immediately and delete this email from your system.",
      "Any unauthorized review, use, disclosure, or distribution is prohibited.",
      "Acme Logistics LLC | 123 Main St | Anytown, USA",
      "https://acme.example.com",
      "© 2026 Acme Logistics LLC. All rights reserved.",
    ].join("\n");
    const out = resolvePreviewSnippet(body);
    expect(out).toBe("Quote for lane 123 attached.");
    expect(out).not.toMatch(/confidential/i);
    expect(out).not.toMatch(/intended recipient/i);
  });

  it("strips an 'On <date>… wrote:' quoted-reply tail", () => {
    const body = [
      "Sounds good, thanks!",
      "",
      "On Mon, Apr 5, 2025 at 9:14 AM John Doe <john@example.com> wrote:",
      "> Original message body that should not appear in the preview.",
      "> More quoted content with secrets.",
    ].join("\n");
    const out = resolvePreviewSnippet(body);
    expect(out).toBe("Sounds good, thanks!");
    expect(out).not.toMatch(/original message body/i);
    expect(out).not.toMatch(/secrets/i);
  });

  it("strips an Outlook 'From: … Sent: …' quoted-reply header", () => {
    const body = [
      "Confirmed for pickup tomorrow at 8am.",
      "",
      "From: Jane Doe <jane@shipper.example>",
      "Sent: Friday, April 5, 2025 3:14 PM",
      "To: dispatch@broker.example",
      "Subject: Lane 123 booking",
      "",
      "Hi team — please confirm the rate for next week.",
    ].join("\n");
    const out = resolvePreviewSnippet(body);
    expect(out).toBe("Confirmed for pickup tomorrow at 8am.");
    expect(out).not.toMatch(/jane@shipper/i);
  });

  it("strips an '-----Original Message-----' separator and tail", () => {
    const body = [
      "Approved on our end, please proceed.",
      "",
      "-----Original Message-----",
      "From: ops@carrier.example",
      "Need confirmation by EOD.",
    ].join("\n");
    const out = resolvePreviewSnippet(body);
    expect(out).toBe("Approved on our end, please proceed.");
  });

  it("truncates to ~120 characters with an ellipsis on a word boundary", () => {
    const long =
      "This is an unusually long preview body that the helper must truncate so that the row layout does not break in the inbox table. After this point you should not see the rest.";
    const out = resolvePreviewSnippet(long);
    expect(out.length).toBeLessThanOrEqual(121); // includes the ellipsis char
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/should not see/i);
  });

  it("respects a custom maxChars override", () => {
    const long = "a b c d e f g h i j k l m n o p q r s t u v w x y z".repeat(5);
    const out = resolvePreviewSnippet(long, { maxChars: 30 });
    // Allow a small +1 for the trailing ellipsis character.
    expect(out.length).toBeLessThanOrEqual(31);
    expect(out.endsWith("…")).toBe(true);
  });

  it("handles a banner-heavy body where the entire reply is one short line", () => {
    const body = [
      "[EXTERNAL EMAIL]",
      "CAUTION: This message originated from outside your organization.",
      "Do not click links or open attachments unless you trust the sender.",
      "",
      "Thanks!",
    ].join("\n");
    const out = resolvePreviewSnippet(body);
    expect(out).toBe("Thanks!");
  });

  it("does not re-introduce a quoted block that contains its own banner", () => {
    // Defensive: even if the quoted block contains a CAUTION banner, the
    // quoted-reply strip should drop the whole thing in one shot before
    // we ever look at banner stripping.
    const body = [
      "Booked, thanks.",
      "",
      "On Mon, Apr 5, 2025 at 9:14 AM John wrote:",
      "> CAUTION: external email",
      "> Please send rate.",
    ].join("\n");
    const out = resolvePreviewSnippet(body);
    expect(out).toBe("Booked, thanks.");
  });
});
