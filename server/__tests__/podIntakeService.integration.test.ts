/**
 * Integration test for the POD intake pipeline orchestrator
 * (`ingestPodEmail`). Uses `vi.mock()` to stub the storage layer plus the
 * `IngestPodEmailDeps` injection point on the orchestrator to swap out
 * the DB-aware helpers and the Outlook send. What we're verifying here is
 * the orchestration: classify → match → resolve → forward → persist.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted, so close-over via vi.hoisted().
const mocks = vi.hoisted(() => ({
  upsertPodIntakeEmailMock: vi.fn(),
}));
const { upsertPodIntakeEmailMock } = mocks;

vi.mock("../storage", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  },
  storage: {
    upsertPodIntakeEmail: mocks.upsertPodIntakeEmailMock,
  },
}));

// Stub OpenAI so accidental AI calls don't hit the network.
vi.mock("openai", () => ({
  default: class {
    chat = {
      completions: {
        create: async () => ({
          choices: [{ message: { content: "{}" } }],
        }),
      },
    };
  },
}));

// Now import the service — picks up the mocked modules above.
import * as svc from "../services/podIntakeService";

const POD_PDF = {
  id: "att-1",
  name: "delivery_receipt_VT123456.pdf",
  contentType: "application/pdf",
  sizeBytes: 250_000,
  contentBase64: undefined,
};

const NEUTRAL_PDF = {
  id: "att-9",
  name: "scan001.pdf",
  contentType: "application/pdf",
  sizeBytes: 200_000,
  contentBase64: undefined,
};

function baseInput(
  overrides: Partial<svc.IngestPodEmailInput> = {},
): svc.IngestPodEmailInput {
  return {
    orgId: "org-test-001",
    mailboxId: "mb-001",
    mailboxAddress: "getpaid@valuetruckaz.com",
    graphMessageId: "graph-msg-001",
    internetMessageId: "<imid-001@mail.example>",
    receivedAt: new Date("2026-04-24T12:00:00Z"),
    fromEmail: "shipper@acme.com",
    fromName: "Acme Shipper",
    subject: "POD VT123456 attached",
    bodyText: "Please find attached the proof of delivery for VT123456.",
    bodyPreview: "Please find attached the proof of delivery for VT123456.",
    attachments: [POD_PDF],
    ...overrides,
  };
}

describe("ingestPodEmail orchestration", () => {
  beforeEach(() => {
    upsertPodIntakeEmailMock.mockReset();
    upsertPodIntakeEmailMock.mockImplementation(async (row: any) => ({
      ...row,
      id: "row-mock-1",
    }));
  });

  it("classifies, matches, forwards, and persists a happy-path POD", async () => {
    const matchFn = vi.fn().mockResolvedValue({
      loadFactId: "lf-001",
      orderId: "VT123456",
      companyId: "co-001",
      customerName: "Acme",
      dispatcher: "Jane Smith",
      pickupDate: null,
      deliveryDate: null,
    });
    const resolveFn = vi.fn().mockResolvedValue({
      dispatcher: { email: "jane.smith@valuetruckaz.com", name: "Jane Smith" },
      accountOwner: { email: "rep@valuetruckaz.com" },
      teamFallback: { email: "ops@valuetruckaz.com" },
    });
    const forwardFn = vi.fn().mockResolvedValue({
      ok: true,
      to: ["jane.smith@valuetruckaz.com", "rep@valuetruckaz.com"],
    });

    const result = await svc.ingestPodEmail(baseInput(), {
      matchOrderIdToLoad: matchFn,
      resolveRecipients: resolveFn,
      forwardPod: forwardFn,
    });

    expect(result.classification).toBe("pod_keyword");
    expect(result.forwardStatus).toBe("forwarded");
    expect(matchFn).toHaveBeenCalledOnce();
    expect(matchFn.mock.calls[0][1]).toContain("VT123456");
    expect(forwardFn).toHaveBeenCalledOnce();
    expect(upsertPodIntakeEmailMock).toHaveBeenCalledOnce();

    const persisted = upsertPodIntakeEmailMock.mock.calls[0][0];
    expect(persisted.classification).toBe("pod_keyword");
    expect(persisted.matchedOrderId).toBe("VT123456");
    expect(persisted.matchedLoadFactId).toBe("lf-001");
    expect(persisted.matchedCompanyId).toBe("co-001");
    expect(persisted.forwardStatus).toBe("forwarded");
    expect(persisted.forwardedAt).toBeInstanceOf(Date);
    expect(persisted.forwardedTo?.dispatcher?.email).toBe(
      "jane.smith@valuetruckaz.com",
    );
    expect(persisted.forwardedTo?.accountOwner?.email).toBe(
      "rep@valuetruckaz.com",
    );
    expect(persisted.extractedOrderIds).toContain("VT123456");
  });

  it("classifies POD but flags 'unmatched' when order ID matches no load", async () => {
    const matchFn = vi.fn().mockResolvedValue(null);
    const resolveFn = vi.fn().mockResolvedValue({
      dispatcher: null,
      accountOwner: null,
      teamFallback: { email: "ops@valuetruckaz.com" },
    });
    const forwardFn = vi.fn().mockResolvedValue({
      ok: true,
      to: ["ops@valuetruckaz.com"],
    });

    const result = await svc.ingestPodEmail(baseInput(), {
      matchOrderIdToLoad: matchFn,
      resolveRecipients: resolveFn,
      forwardPod: forwardFn,
    });

    expect(result.classification).toBe("pod_keyword");
    expect(result.forwardStatus).toBe("unmatched");

    const persisted = upsertPodIntakeEmailMock.mock.calls[0][0];
    expect(persisted.matchedOrderId).toBeNull();
    expect(persisted.matchedLoadFactId).toBeNull();
    expect(persisted.forwardStatus).toBe("unmatched");
    expect(persisted.forwardedTo?.teamFallback?.email).toBe(
      "ops@valuetruckaz.com",
    );
  });

  it("short-circuits non-POD messages without invoking match/forward", async () => {
    const matchFn = vi.fn();
    const resolveFn = vi.fn();
    const forwardFn = vi.fn();

    const result = await svc.ingestPodEmail(
      baseInput({
        subject: "Invoice 9912 — payment question",
        bodyText: "Hi, when can we expect payment for invoice 9912? Thanks.",
        bodyPreview: "Hi, when can we expect payment for invoice 9912? Thanks.",
        attachments: [NEUTRAL_PDF],
      }),
      {
        matchOrderIdToLoad: matchFn,
        resolveRecipients: resolveFn,
        forwardPod: forwardFn,
      },
    );

    expect(result.classification).toBe("not_pod");
    expect(result.forwardStatus).toBe("not_pod");
    expect(matchFn).not.toHaveBeenCalled();
    expect(forwardFn).not.toHaveBeenCalled();

    const persisted = upsertPodIntakeEmailMock.mock.calls[0][0];
    expect(persisted.classification).toBe("not_pod");
    expect(persisted.forwardStatus).toBe("not_pod");
    expect(persisted.matchedOrderId).toBeNull();
    expect(persisted.forwardedAt).toBeNull();
  });

  it("records 'failed' forwardStatus when send fails", async () => {
    const matchFn = vi.fn().mockResolvedValue({
      loadFactId: "lf-002",
      orderId: "VT777777",
      companyId: "co-002",
      customerName: null,
      dispatcher: null,
      pickupDate: null,
      deliveryDate: null,
    });
    const resolveFn = vi.fn().mockResolvedValue({
      dispatcher: { email: "joe@valuetruckaz.com" },
      accountOwner: null,
      teamFallback: null,
    });
    const forwardFn = vi
      .fn()
      .mockResolvedValue({ ok: false, to: [], error: "Graph 503" });

    const result = await svc.ingestPodEmail(baseInput(), {
      matchOrderIdToLoad: matchFn,
      resolveRecipients: resolveFn,
      forwardPod: forwardFn,
    });

    expect(result.forwardStatus).toBe("failed");
    const persisted = upsertPodIntakeEmailMock.mock.calls[0][0];
    expect(persisted.forwardStatus).toBe("failed");
    expect(persisted.forwardError).toMatch(/Graph 503/);
    expect(persisted.forwardedAt).toBeNull();
  });
});
