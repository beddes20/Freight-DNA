// Task #968 — round-3 hardening unit tests for the Conversations
// page's pure helpers. Pinned with vitest so a future refactor can't
// silently regress the persisted-key shape, the viewer-aware bucket
// mapping, or the Convert-to-quote notes prefill contract.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  REP_FILTER_KEY_PREFIX,
  repFilterKey,
  loadRepFilter,
} from "@/lib/conversations/repFilterStorage";
import { buildConvertToQuoteDefaults } from "@/lib/conversations/convertToQuoteDefaults";
import { resolveBucketLabel } from "@/components/conversations/types";

// ── localStorage stub (vitest runs in node env per vitest.config.ts) ──────
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string) { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string) { this.store.set(k, v); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
  key(_i: number) { return null; }
  get length() { return this.store.size; }
}

describe("repFilterStorage.loadRepFilter", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { localStorage: new MemoryStorage() };
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it("uses the documented key prefix", () => {
    expect(REP_FILTER_KEY_PREFIX).toBe("conversations:repFilter:");
    expect(repFilterKey("user-123")).toBe("conversations:repFilter:user-123");
    expect(repFilterKey(null)).toBeNull();
    expect(repFilterKey(undefined)).toBeNull();
  });

  it("falls back to 'all' when no userId is provided", () => {
    expect(loadRepFilter(null)).toBe("all");
    expect(loadRepFilter(undefined)).toBe("all");
    expect(loadRepFilter("")).toBe("all");
  });

  it("falls back to 'all' when nothing is persisted", () => {
    expect(loadRepFilter("user-abc")).toBe("all");
  });

  it("round-trips a saved value (URL → setItem → loadRepFilter)", () => {
    const ls = (globalThis as { window: { localStorage: MemoryStorage } }).window.localStorage;
    ls.setItem("conversations:repFilter:user-abc", "user-xyz");
    expect(loadRepFilter("user-abc")).toBe("user-xyz");

    ls.setItem("conversations:repFilter:user-abc", "unassigned");
    expect(loadRepFilter("user-abc")).toBe("unassigned");

    ls.setItem("conversations:repFilter:user-abc", "all");
    expect(loadRepFilter("user-abc")).toBe("all");
  });

  it("scopes per-user — userA's value doesn't leak into userB", () => {
    const ls = (globalThis as { window: { localStorage: MemoryStorage } }).window.localStorage;
    ls.setItem("conversations:repFilter:userA", "user-A-pick");
    ls.setItem("conversations:repFilter:userB", "user-B-pick");
    expect(loadRepFilter("userA")).toBe("user-A-pick");
    expect(loadRepFilter("userB")).toBe("user-B-pick");
  });

  it("falls back to 'all' when window is undefined (SSR safety)", () => {
    (globalThis as { window?: unknown }).window = undefined;
    expect(loadRepFilter("user-abc")).toBe("all");
  });
});

describe("resolveBucketLabel", () => {
  const VIEWER = "viewer-1";
  const OTHER = "other-2";

  it("maps waiting_on_us + ownerUserId === viewer to Mine", () => {
    const r = resolveBucketLabel("waiting_on_us", VIEWER, VIEWER);
    expect(r).toEqual({ key: "mine", label: "Mine", bucket: "mine" });
  });

  it("maps waiting_on_us + owned by another rep to Owned (lands in All)", () => {
    const r = resolveBucketLabel("waiting_on_us", OTHER, VIEWER);
    expect(r).toEqual({ key: "owned", label: "Owned", bucket: "all" });
  });

  it("maps waiting_on_us + no owner to Unowned", () => {
    const r = resolveBucketLabel("waiting_on_us", null, VIEWER);
    expect(r).toEqual({ key: "unowned", label: "Unowned", bucket: "unowned" });
  });

  it("maps waiting_on_them to Awaiting customer (lands in All)", () => {
    const r = resolveBucketLabel("waiting_on_them", VIEWER, VIEWER);
    expect(r).toEqual({ key: "awaiting_customer", label: "Awaiting customer", bucket: "all" });
  });

  it("maps resolved/archived/snoozed to their respective buckets", () => {
    expect(resolveBucketLabel("resolved", null, VIEWER).bucket).toBe("all");
    expect(resolveBucketLabel("archived", null, VIEWER).bucket).toBe("archived");
    expect(resolveBucketLabel("snoozed", null, VIEWER).bucket).toBe("snoozed");
  });

  it("falls back to All for an unknown waitingState", () => {
    const r = resolveBucketLabel("garbled", null, VIEWER);
    expect(r).toEqual({ key: "all", label: "All", bucket: "all" });
  });

  it("treats null viewer + matching owner as Owned, not Mine", () => {
    const r = resolveBucketLabel("waiting_on_us", VIEWER, null);
    expect(r.key).toBe("owned");
  });
});

describe("buildConvertToQuoteDefaults", () => {
  it("seeds the header with the thread subject and clears origin/dest fields", () => {
    const out = buildConvertToQuoteDefaults("RFQ ATL → ORD", null);
    expect(out.notes.startsWith("Converted from email thread: RFQ ATL → ORD")).toBe(true);
    expect(out.customerId).toBe("");
    expect(out.originCity).toBe("");
    expect(out.destCity).toBe("");
    expect(out.equipment).toBe("Dry Van");
  });

  it("appends the latest inbound body under a 'Latest inbound:' label when provided", () => {
    const out = buildConvertToQuoteDefaults("Subj", "Need a rate ATL to ORD by Friday");
    expect(out.notes).toContain("Latest inbound:");
    expect(out.notes).toContain("Need a rate ATL to ORD by Friday");
  });

  it("trims a leading-quoted-reply prefix so previous outbound rep mail doesn't bleed in", () => {
    const inbound = [
      "Yes, please quote it.",
      "",
      "On Mon Jun 3, 2024, Carrier wrote:",
      "> Original outbound rep email",
      "> with quoted lines",
    ].join("\n");
    const out = buildConvertToQuoteDefaults("Subj", inbound);
    expect(out.notes).toContain("Yes, please quote it.");
    expect(out.notes).not.toContain("Original outbound rep email");
    expect(out.notes).not.toContain("quoted lines");
  });

  it("collapses arbitrary internal whitespace runs to single spaces", () => {
    const out = buildConvertToQuoteDefaults("Subj", "Need\n\n\t  rate   please");
    expect(out.notes).toContain("Need rate please");
  });

  it("caps the combined header+body at 1900 chars", () => {
    const huge = "x".repeat(5000);
    const out = buildConvertToQuoteDefaults("Subj", huge);
    expect(out.notes.length).toBeLessThanOrEqual(1900);
  });

  it("omits the inbound section entirely when latestInboundBody is empty/whitespace", () => {
    expect(buildConvertToQuoteDefaults("Subj", "").notes).not.toContain("Latest inbound:");
    expect(buildConvertToQuoteDefaults("Subj", "   \n   ").notes).not.toContain("Latest inbound:");
    expect(buildConvertToQuoteDefaults("Subj", undefined).notes).not.toContain("Latest inbound:");
  });
});
