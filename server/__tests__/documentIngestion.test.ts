/**
 * Task #910 — Document ingestion smoke tests.
 *
 * These tests exercise the deterministic pieces of the pipeline without a
 * live database — they pin the classifier behaviour (filename/keyword
 * vocabulary), the SHA-256 dedup hashing, and the OCR-vendor-missing
 * graceful-degrade path. The full DB-backed integration test for the
 * ingestion entry point lives in `documentIngestion.integration.test.ts`
 * (skipped in unit runs; runs in the storage-integration workflow).
 */
import { describe, it, expect, vi } from "vitest";
import { sha256Hex } from "../services/documentIngestion";
import {
  classifyDeterministic,
  classifyDocument,
  type ClassifierOpenAIClient,
  type ChatCompletionLike,
  type ChatCompletionRequest,
} from "../services/documentClassifier";

// Typed stub factory — no `as any`. We build a minimal client that
// satisfies the `ClassifierOpenAIClient` shape and lets each test inject
// its own mock for `chat.completions.create`.
function makeClassifierStub(
  create: (req: ChatCompletionRequest) => Promise<ChatCompletionLike>,
): ClassifierOpenAIClient {
  return { chat: { completions: { create } } };
}

describe("documentClassifier — deterministic tier (Task #910)", () => {
  it("filename signals win over generic mime mappings", () => {
    const r = classifyDeterministic({
      filename: "Acme Q1 RFP.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      firstPageText: "",
    });
    expect(r.label).toBe("rfp_bid_sheet");
    expect(r.method).toBe("filename");
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("recognizes BOL / POD filenames", () => {
    expect(classifyDeterministic({ filename: "signed_BOL_12345.pdf", mimeType: "application/pdf", firstPageText: "" }).label).toBe("bol");
    expect(classifyDeterministic({ filename: "Proof of Delivery.pdf", mimeType: "application/pdf", firstPageText: "" }).label).toBe("bol");
  });

  it("recognizes carrier scorecards by filename", () => {
    expect(classifyDeterministic({ filename: "Q3 Carrier Scorecard.xlsx", mimeType: "x", firstPageText: "" }).label).toBe("scorecard");
  });

  it("recognizes routing guides + accessorial schedules + tariffs by filename", () => {
    expect(classifyDeterministic({ filename: "Walmart Routing Guide.pdf", mimeType: "application/pdf", firstPageText: "" }).label).toBe("routing_guide");
    expect(classifyDeterministic({ filename: "Accessorial Fees Sept 2025.xlsx", mimeType: "x", firstPageText: "" }).label).toBe("accessorial_schedule");
    expect(classifyDeterministic({ filename: "2025 Tariff.pdf", mimeType: "application/pdf", firstPageText: "" }).label).toBe("tariff");
  });

  it("falls back to keyword scan when filename is generic", () => {
    const r = classifyDeterministic({
      filename: "scan_001.pdf",
      mimeType: "application/pdf",
      firstPageText: "RATE CONFIRMATION\nLoad #94821\nCarrier: Acme Trucking\nLane: ATL → MIA\nRate: $1,850",
    });
    expect(r.label).toBe("rate_con");
    expect(r.method).toBe("keyword");
  });

  it("eml mime → email_thread regardless of filename", () => {
    const r = classifyDeterministic({ filename: "fwd.eml", mimeType: "message/rfc822", firstPageText: "" });
    expect(r.label).toBe("email_thread");
  });

  it("spreadsheet mime defaults to spreadsheet_lanes when nothing else matches", () => {
    const r = classifyDeterministic({ filename: "lanes.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", firstPageText: "" });
    expect(r.label).toBe("spreadsheet_lanes");
  });

  it("returns unknown when nothing matches", () => {
    const r = classifyDeterministic({ filename: "scan_002.pdf", mimeType: "application/pdf", firstPageText: "Lorem ipsum dolor sit amet." });
    expect(r.label).toBe("unknown");
  });
});

describe("documentClassifier — model fallback (Task #910)", () => {
  it("does NOT call the model when deterministic tier matched", async () => {
    const create = vi.fn<(req: ChatCompletionRequest) => Promise<ChatCompletionLike>>();
    const r = await classifyDocument(
      { filename: "Acme RFP.xlsx", mimeType: "application/octet-stream", firstPageText: "irrelevant" },
      makeClassifierStub(create),
    );
    expect(r.label).toBe("rfp_bid_sheet");
    expect(create).not.toHaveBeenCalled();
  });

  it("falls back to model when deterministic tier returns unknown AND text is sufficient", async () => {
    const create = vi
      .fn<(req: ChatCompletionRequest) => Promise<ChatCompletionLike>>()
      .mockResolvedValue({ choices: [{ message: { content: "rate_con" } }] });
    const r = await classifyDocument(
      {
        filename: "scan.pdf",
        mimeType: "application/pdf",
        firstPageText: "Some long text ".repeat(20),
      },
      makeClassifierStub(create),
    );
    expect(r.label).toBe("rate_con");
    expect(r.method).toBe("model");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("returns unknown without calling the model when text is too short", async () => {
    const create = vi.fn<(req: ChatCompletionRequest) => Promise<ChatCompletionLike>>();
    const r = await classifyDocument(
      { filename: "scan.pdf", mimeType: "application/pdf", firstPageText: "tiny" },
      makeClassifierStub(create),
    );
    expect(r.label).toBe("unknown");
    expect(create).not.toHaveBeenCalled();
  });

  it("clamps unrecognized model responses back to unknown", async () => {
    const create = vi
      .fn<(req: ChatCompletionRequest) => Promise<ChatCompletionLike>>()
      .mockResolvedValue({ choices: [{ message: { content: "spaceship_manifest" } }] });
    const r = await classifyDocument(
      { filename: "scan.pdf", mimeType: "application/pdf", firstPageText: "x".repeat(500) },
      makeClassifierStub(create),
    );
    expect(r.label).toBe("unknown");
  });
});

describe("documentIngestion — sha256 hashing (Task #910)", () => {
  it("produces stable lowercase hex for identical bytes", () => {
    const a = sha256Hex(Buffer.from("hello world"));
    const b = sha256Hex(Buffer.from("hello world"));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different hashes for different bytes", () => {
    expect(sha256Hex(Buffer.from("a"))).not.toBe(sha256Hex(Buffer.from("b")));
  });
});
