/**
 * Unit tests for the pure helpers in server/services/podIntakeService.ts.
 * Database-aware helpers (matchOrderIdToLoad, resolveRecipients) are
 * exercised by the integration tests that hit a real DB.
 */
import { describe, it, expect } from "vitest";
import {
  hasPodKeywordHit,
  classifyPod,
  extractOrderIds,
  type PodCandidateMessage,
} from "../services/podIntakeService";

function msg(overrides: Partial<PodCandidateMessage> = {}): PodCandidateMessage {
  return {
    subject: "",
    bodyText: "",
    bodyPreview: "",
    fromEmail: "test@example.com",
    fromName: "Test",
    attachments: [],
    ...overrides,
  };
}

const POD_PDF = {
  id: "att-1",
  name: "delivery_receipt.pdf",
  contentType: "application/pdf",
  sizeBytes: 250_000,
};

const TINY_SIG_IMAGE = {
  id: "att-2",
  name: "signature.png",
  contentType: "image/png",
  sizeBytes: 1_200, // below the 4KB floor
};

const HUGE_PDF = {
  id: "att-3",
  name: "scan.pdf",
  contentType: "application/pdf",
  sizeBytes: 30 * 1024 * 1024, // > 25MB cap
};

const PLAIN_PDF_NO_HINT = {
  id: "att-4",
  name: "scan001.pdf",
  contentType: "application/pdf",
  sizeBytes: 200_000,
};

describe("hasPodKeywordHit", () => {
  it("hits on subject keyword", () => {
    const r = hasPodKeywordHit(msg({ subject: "POD VT123456 attached" }));
    expect(r.hit).toBe(true);
    expect(r.matchedKeyword).toBe("pod");
  });

  it("hits on multi-word body keyword", () => {
    const r = hasPodKeywordHit(
      msg({ bodyText: "Please see attached proof of delivery for our order." }),
    );
    expect(r.hit).toBe(true);
    expect(r.matchedKeyword).toBe("proof of delivery");
  });

  it("hits on attachment filename pattern", () => {
    const r = hasPodKeywordHit(
      msg({ attachments: [{ ...PLAIN_PDF_NO_HINT, name: "VT123_POD.pdf" }] }),
    );
    expect(r.hit).toBe(true);
    expect(r.matchedAttachmentName).toBe("VT123_POD.pdf");
  });

  it("does not false-positive on words containing 'pod' as a substring", () => {
    const r = hasPodKeywordHit(
      msg({ subject: "Tripod accessories for sale", bodyText: "podiatrist" }),
    );
    expect(r.hit).toBe(false);
  });

  it("does not false-positive on words containing 'bol' as a substring", () => {
    const r = hasPodKeywordHit(msg({ bodyText: "carbol cleaner inquiry" }));
    expect(r.hit).toBe(false);
  });
});

describe("classifyPod", () => {
  it("classifies as pod_keyword when keyword + plausible attachment present", async () => {
    const r = await classifyPod(
      msg({ subject: "POD VT123456", attachments: [POD_PDF] }),
      { useAiFallback: false },
    );
    expect(r.classification).toBe("pod_keyword");
    expect(r.method).toBe("keyword");
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it("classifies as not_pod when no plausible attachment", async () => {
    const r = await classifyPod(
      msg({ subject: "POD VT123456", attachments: [TINY_SIG_IMAGE] }),
      { useAiFallback: true },
    );
    expect(r.classification).toBe("not_pod");
    expect(r.reason).toMatch(/attachment/i);
  });

  it("classifies as not_pod when keyword missing and AI fallback disabled", async () => {
    const r = await classifyPod(
      msg({ subject: "Invoice 9912", attachments: [PLAIN_PDF_NO_HINT] }),
      { useAiFallback: false },
    );
    expect(r.classification).toBe("not_pod");
  });

  it("uses AI fallback when keyword missing but plausible attachment present", async () => {
    const r = await classifyPod(
      msg({ subject: "Some scan", attachments: [PLAIN_PDF_NO_HINT] }),
      {
        useAiFallback: true,
        aiClassifierFn: async () => ({
          isPod: true,
          confidence: 0.82,
          reason: "AI says yes",
        }),
      },
    );
    expect(r.classification).toBe("pod_ai");
    expect(r.method).toBe("ai");
    expect(r.confidence).toBeCloseTo(0.82);
  });

  it("returns error classification when AI throws", async () => {
    const r = await classifyPod(
      msg({ subject: "?", attachments: [PLAIN_PDF_NO_HINT] }),
      {
        useAiFallback: true,
        aiClassifierFn: async () => {
          throw new Error("network down");
        },
      },
    );
    expect(r.classification).toBe("error");
    expect(r.reason).toMatch(/network down/);
  });

  it("rejects oversized attachments as POD candidates", async () => {
    const r = await classifyPod(
      msg({ subject: "POD attached", attachments: [HUGE_PDF] }),
      { useAiFallback: false },
    );
    expect(r.classification).toBe("not_pod");
  });
});

describe("extractOrderIds", () => {
  it("extracts canonical VT###### from subject", () => {
    const ids = extractOrderIds(msg({ subject: "POD VT123456 attached" }));
    expect(ids).toContain("VT123456");
  });

  it("extracts VT id with dash separator", () => {
    const ids = extractOrderIds(msg({ subject: "Delivery for VT-987654" }));
    expect(ids).toContain("VT987654");
  });

  it("extracts from attachment filename", () => {
    const ids = extractOrderIds(
      msg({
        attachments: [{ ...POD_PDF, name: "VT123456_signed_pod.pdf" }],
      }),
    );
    expect(ids).toContain("VT123456");
  });

  it("extracts from generic Order #N in body", () => {
    const ids = extractOrderIds(
      msg({ bodyText: "Please see attached for Order #12345 delivered yesterday." }),
    );
    expect(ids).toContain("12345");
    expect(ids).toContain("VT12345");
  });

  it("does not extract bare digit runs from arbitrary text", () => {
    const ids = extractOrderIds(
      msg({ bodyText: "Our phone is 5551234567 and account is 999888." }),
    );
    expect(ids).toEqual([]);
  });

  it("dedupes ids across subject + body + attachments", () => {
    const ids = extractOrderIds(
      msg({
        subject: "POD VT123456",
        bodyText: "Order VT123456 delivered",
        attachments: [{ ...POD_PDF, name: "VT123456.pdf" }],
      }),
    );
    expect(ids.filter((x) => x === "VT123456")).toHaveLength(1);
  });
});
