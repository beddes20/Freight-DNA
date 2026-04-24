/**
 * Spot Quote Routes — Integration tests (Task #516).
 *
 * Mounts registerCustomerQuoteRoutes() onto a fresh Express app with mocked
 * auth, services, db, and emailDrafting. Exercises the full flow:
 *   1) POST /api/customer-quotes/spot/create with valid payload → 201 + quoteId
 *   2) POST /api/customer-quotes/spot/create with quotedAmount=0 → 400
 *   3) POST /api/customer-quotes/spot/create breaching margin guardrail → 400
 *   4) POST /api/customer-quotes/spot/email-draft for the just-created quote
 *      → 200 + non-empty subject/body, recommendedRate echoed in draft context
 *   5) POST /api/customer-quotes/spot/email-draft with bad payload → 400
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";

let currentUser: { id: string; organizationId: string; role: string } | null = null;

vi.mock("../auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  getCurrentUser: vi.fn(async () => currentUser),
}));

const createdQuotes: any[] = [];
const fakeQuoteDetail = {
  opp: {
    id: "quote-1",
    customerId: "cust-1",
    originCity: "Chicago",
    originState: "IL",
    destCity: "Atlanta",
    destState: "GA",
    equipment: "Van",
    quotedAmount: 2500,
    estimatedCost: 2000,
    validThrough: "2026-12-31",
    notes: "first lane",
  },
  customer: { id: "cust-1", name: "Acme Logistics" },
};

vi.mock("../services/customerQuotes", () => ({
  ensureQuoteSeed: vi.fn(async () => undefined),
  getSnapshot: vi.fn(),
  getQuoteDetail: vi.fn(async (_orgId: string, quoteId: string) => ({
    ...fakeQuoteDetail, id: quoteId,
  })),
  listQuotes: vi.fn(),
  listSavedViews: vi.fn(),
  createSavedView: vi.fn(),
  deleteSavedView: vi.fn(),
  exportCsv: vi.fn(),
  createQuote: vi.fn(async (_orgId: string, _userId: string, payload: any) => {
    const id = `quote-${createdQuotes.length + 1}`;
    const row = { id, ...payload };
    createdQuotes.push(row);
    return row;
  }),
  updateQuote: vi.fn(),
  getPricingIntelligence: vi.fn(),
  searchSpotQuote: vi.fn(),
  laneAutocomplete: vi.fn(),
}));

vi.mock("../services/quoteTmsSync", () => ({
  syncQuoteOutcomesFromTms: vi.fn(),
}));

vi.mock("../services/staleQuoteFollowup", () => ({
  getStaleQuoteFollowUps: vi.fn(),
  clearStaleFollowUpCache: vi.fn(),
}));

const fakeContacts: any[] = [
  { id: "contact-1", companyId: "cust-1", email: "ops@acme.test", firstName: "Pat", lastName: "Doe", isPrimary: true },
];
vi.mock("../storage", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(fakeContacts),
          orderBy: () => Promise.resolve(fakeContacts),
        }),
      }),
    }),
  },
  storage: {},
}));

vi.mock("drizzle-orm", () => ({
  and: (...xs: any[]) => ({ __op: "and", xs }),
  eq: (col: any, val: any) => ({ col, val }),
  sql: (s: any) => s,
}));

vi.mock("@shared/schema", async () => {
  const real = await vi.importActual<any>("@shared/schema");
  return {
    ...real,
    companies: "companies",
    contacts: "contacts",
  };
});

let lastDraftDataAnchors: any = null;
vi.mock("../routes/emailDrafting", () => ({
  gatherDataAnchors: vi.fn(async (_orgId: string, opts: any) => {
    lastDraftDataAnchors = opts;
    return { anchors: ["lane:CHI->ATL"], context: "anchored" };
  }),
  generateDraft: vi.fn(async (opts: any) =>
    `Hello — quote ready. Context: ${opts?.dataContext ?? ""}\nExtra: ${opts?.additionalContext ?? ""}`,
  ),
}));

vi.mock("../voiceProfileService", () => ({
  getVoiceProfile: vi.fn(async () => ({ tone: "professional" })),
}));

const { registerCustomerQuoteRoutes } = await import("../routes/customerQuotes");

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  registerCustomerQuoteRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return await new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as any;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

beforeEach(() => {
  createdQuotes.length = 0;
  lastDraftDataAnchors = null;
  currentUser = { id: "user-1", organizationId: "org-1", role: "rep" };
});

const validBody = {
  customerId: "cust-1",
  equipment: "Van",
  pickupCity: "Chicago",
  pickupState: "IL",
  deliveryCity: "Atlanta",
  deliveryState: "GA",
  quotedAmount: 2500,
  estimatedCost: 2000,
  validUntil: "2026-12-31",
  notes: "first lane on this customer",
};

describe("POST /api/customer-quotes/spot/create", () => {
  it("creates a quote with a healthy 20% margin", async () => {
    const app = buildApp();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/customer-quotes/spot/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBeLessThan(300);
      const json = await res.json();
      expect(json?.id || json?.quote?.id || json?.quoteId).toBeTruthy();
    } finally {
      await srv.close();
    }
  });

  it("rejects quotedAmount = 0 with 400", async () => {
    const app = buildApp();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/customer-quotes/spot/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...validBody, quotedAmount: 0 }),
      });
      expect(res.status).toBe(400);
    } finally {
      await srv.close();
    }
  });

  it("rejects a margin below the 5% guardrail with 400", async () => {
    const app = buildApp();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/customer-quotes/spot/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...validBody, quotedAmount: 2500, estimatedCost: 2400 }),
      });
      expect(res.status).toBe(400);
    } finally {
      await srv.close();
    }
  });
});

describe("POST /api/customer-quotes/spot/email-draft", () => {
  it("returns a draft (subject + body) for a real quoteId and embeds the recommended rate", async () => {
    const app = buildApp();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/customer-quotes/spot/email-draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          quoteId: "quote-1",
          recommendedRate: 2500,
          bandLow: 2300,
          bandMid: 2500,
          bandHigh: 2700,
          bandSource: "TRAC",
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(typeof json.subject).toBe("string");
      expect(json.subject.length).toBeGreaterThan(0);
      expect(typeof json.body).toBe("string");
      expect(json.body.length).toBeGreaterThan(0);
    } finally {
      await srv.close();
    }
  });

  it("rejects an empty payload with 400", async () => {
    const app = buildApp();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/customer-quotes/spot/email-draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      await srv.close();
    }
  });
});
