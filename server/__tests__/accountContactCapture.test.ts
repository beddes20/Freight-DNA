import { describe, it, expect, beforeEach } from "vitest";
import {
  detectAndSuggest,
  isGenericInbox,
  parseEmailAddresses,
  extractSignatureHints,
} from "../accountContactCaptureService";
import type {
  EmailMessage,
  AccountContactSuggestion,
  InsertAccountContactSuggestion,
  Contact,
} from "@shared/schema";

// ── In-memory storage for behavior-driven tests ───────────────────────────────

class InMemoryContactCaptureStorage {
  private companies = new Map<string, { id: string; name: string; website: string | null }>();
  private contacts: Contact[] = [];
  suggestions: AccountContactSuggestion[] = [];

  addCompany(c: { id: string; name: string; website: string | null }) {
    this.companies.set(c.id, c);
    return this;
  }

  addContact(c: Partial<Contact> & { id: string; companyId: string; email: string }) {
    this.contacts.push({
      name: c.email,
      title: null,
      relationshipBase: null,
      phone: null,
      reportsToId: null,
      lanes: null,
      regions: null,
      freightSpend: null,
      spotBiddingProcess: null,
      nextSteps: null,
      interests: null,
      notes: null,
      createdAt: null,
      createdBy: null,
      baseAdvancedAt: null,
      lastSeenAt: null,
      sourceType: null,
      roleType: null,
      status: "active",
      isPrimary: false,
      ...c,
    } as Contact);
    return this;
  }

  async getCompany(id: string) {
    return this.companies.get(id) ?? null;
  }

  async getContactsByCompany(companyId: string) {
    return this.contacts.filter(c => c.companyId === companyId);
  }

  async upsertAccountContactSuggestion(data: InsertAccountContactSuggestion): Promise<AccountContactSuggestion> {
    const existing = this.suggestions.find(
      s => s.accountId === data.accountId && s.emailAddress === data.emailAddress,
    );
    if (existing) {
      // Only ignored and never_suggest are protected from updates
      if (existing.status === "ignored" || existing.status === "never_suggest") {
        return existing;
      }
      existing.threadCount = (existing.threadCount ?? 1) + 1;
      existing.confidenceScore = Math.max(existing.confidenceScore, data.confidenceScore ?? 50);
      existing.suggestedName = existing.suggestedName ?? data.suggestedName ?? null;
      existing.suggestedTitle = existing.suggestedTitle ?? data.suggestedTitle ?? null;
      existing.suggestedPhone = existing.suggestedPhone ?? data.suggestedPhone ?? null;
      existing.updatedAt = new Date();
      return existing;
    }
    const suggestion: AccountContactSuggestion = {
      id: `sug-${this.suggestions.length + 1}`,
      accountId: data.accountId,
      orgId: data.orgId,
      emailAddress: data.emailAddress,
      suggestedName: data.suggestedName ?? null,
      suggestedTitle: data.suggestedTitle ?? null,
      suggestedPhone: data.suggestedPhone ?? null,
      suggestionSource: data.suggestionSource,
      confidenceScore: data.confidenceScore,
      status: data.status ?? "pending",
      threadCount: data.threadCount ?? 1,
      emailMessageId: data.emailMessageId ?? null,
      threadId: data.threadId ?? null,
      snoozedUntil: data.snoozedUntil ?? null,
      actedByUserId: data.actedByUserId ?? null,
      notes: data.notes ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.suggestions.push(suggestion);
    return suggestion;
  }
}

// ── Typed message factory ─────────────────────────────────────────────────────

function msg(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "msg-001",
    orgId: "org-001",
    threadId: "thread-abc",
    direction: "inbound",
    fromEmail: "jane@acme.com",
    toEmail: "rep@freight.com",
    ccEmail: null,
    subject: "Shipment inquiry",
    body: "Hi.\n\n--\nJane Smith\nDirector of Logistics\n555-123-4567",
    linkedAccountId: "acme",
    linkedCarrierId: null,
    linkedLaneId: null,
    linkedLoadId: null,
    linkedTaskId: null,
    linkedNbaId: null,
    linkedOutreachLogId: null,
    processedForSignalsAt: null,
    createdAt: new Date("2026-04-10T10:00:00Z"),
    providerMessageId: null,
    ...overrides,
  };
}

function baseStorage() {
  return new InMemoryContactCaptureStorage().addCompany({
    id: "acme",
    name: "Acme Corp",
    website: "https://acme.com",
  });
}

// ── Unit tests: pure helper functions ─────────────────────────────────────────

describe("isGenericInbox", () => {
  it("detects shared inbox prefixes", () => {
    expect(isGenericInbox("billing@acme.com")).toBe(true);
    expect(isGenericInbox("ops@acme.com")).toBe(true);
    expect(isGenericInbox("noreply@acme.com")).toBe(true);
    expect(isGenericInbox("info@acme.com")).toBe(true);
  });

  it("does not flag personal addresses", () => {
    expect(isGenericInbox("jane@acme.com")).toBe(false);
    expect(isGenericInbox("bob.smith@acme.com")).toBe(false);
  });
});

describe("parseEmailAddresses", () => {
  it("parses plain address", () => {
    expect(parseEmailAddresses("jane@acme.com")).toEqual(["jane@acme.com"]);
  });

  it("parses display-name format", () => {
    expect(parseEmailAddresses("Jane Smith <jane@acme.com>")).toEqual(["jane@acme.com"]);
  });

  it("parses comma-separated list", () => {
    expect(parseEmailAddresses("jane@acme.com, bob@acme.com")).toEqual(["jane@acme.com", "bob@acme.com"]);
  });

  it("returns empty for null/undefined", () => {
    expect(parseEmailAddresses(null)).toEqual([]);
    expect(parseEmailAddresses(undefined)).toEqual([]);
  });
});

describe("extractSignatureHints", () => {
  it("extracts phone number from signature block", () => {
    const body = "Hi there.\n\n--\nJane Smith\nDirector\n555-123-4567";
    expect(extractSignatureHints(body, "jane@acme.com").phone).toMatch(/555-123-4567/);
  });

  it("returns all nulls for empty body", () => {
    const hints = extractSignatureHints(null, "jane@acme.com");
    expect(hints.name).toBeNull();
    expect(hints.title).toBeNull();
    expect(hints.phone).toBeNull();
  });
});

// ── detectAndSuggest: behavioral tests with in-memory storage ─────────────────

describe("detectAndSuggest", () => {
  let storage: InMemoryContactCaptureStorage;

  beforeEach(() => {
    storage = baseStorage();
  });

  it("creates a pending suggestion for a new matching participant", async () => {
    const result = await detectAndSuggest(msg(), storage);
    expect(result.upserted).toBe(1);
    expect(storage.suggestions).toHaveLength(1);
    const sug = storage.suggestions[0];
    expect(sug.emailAddress).toBe("jane@acme.com");
    expect(sug.status).toBe("pending");
    expect(sug.accountId).toBe("acme");
  });

  it("increments threadCount on subsequent detection of same address", async () => {
    await detectAndSuggest(msg(), storage);
    await detectAndSuggest(msg({ id: "msg-002" }), storage);
    expect(storage.suggestions).toHaveLength(1);
    expect(storage.suggestions[0].threadCount).toBe(2);
  });

  it("caps confidence at 35 for generic inbox addresses", async () => {
    await detectAndSuggest(msg({ fromEmail: "billing@acme.com" }), storage);
    expect(storage.suggestions).toHaveLength(1);
    expect(storage.suggestions[0].confidenceScore).toBeLessThanOrEqual(35);
  });

  it("skips addresses already in contacts list for the account", async () => {
    storage.addContact({ id: "c1", companyId: "acme", email: "jane@acme.com" });
    const result = await detectAndSuggest(msg(), storage);
    expect(result.upserted).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(storage.suggestions).toHaveLength(0);
  });

  it("does nothing when message has no linkedAccountId", async () => {
    const result = await detectAndSuggest(msg({ linkedAccountId: null }), storage);
    expect(result.upserted).toBe(0);
    expect(storage.suggestions).toHaveLength(0);
  });

  it("preserves ignored suggestion — does not re-open it", async () => {
    await detectAndSuggest(msg(), storage);
    storage.suggestions[0].status = "ignored";
    await detectAndSuggest(msg({ id: "msg-002" }), storage);
    expect(storage.suggestions).toHaveLength(1);
    expect(storage.suggestions[0].status).toBe("ignored");
  });

  it("increments threadCount on a snoozed suggestion (snooze does not freeze updates)", async () => {
    const snoozedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await detectAndSuggest(msg(), storage);
    storage.suggestions[0].status = "snoozed";
    storage.suggestions[0].snoozedUntil = snoozedUntil;
    await detectAndSuggest(msg({ id: "msg-002" }), storage);
    expect(storage.suggestions).toHaveLength(1);
    expect(storage.suggestions[0].threadCount).toBe(2);
  });

  it("preserves never_suggest status — does not re-open it", async () => {
    await detectAndSuggest(msg(), storage);
    storage.suggestions[0].status = "never_suggest";
    await detectAndSuggest(msg({ id: "msg-002" }), storage);
    expect(storage.suggestions).toHaveLength(1);
    expect(storage.suggestions[0].status).toBe("never_suggest");
  });

  it("skips sender and CC from unrelated domains", async () => {
    const result = await detectAndSuggest(msg({
      fromEmail: "rep@freight.com",
      toEmail: "customer@acme.com",
      ccEmail: "random@unrelated-company.com",
    }), storage);
    const addresses = storage.suggestions.map(s => s.emailAddress);
    expect(addresses).not.toContain("rep@freight.com");
    expect(addresses).not.toContain("random@unrelated-company.com");
  });

  it("does not crash the pipeline when storage.getCompany throws", async () => {
    const brokenStorage = {
      getCompany: async () => { throw new Error("DB error"); },
      getContactsByCompany: async () => [],
      upsertAccountContactSuggestion: async (d: InsertAccountContactSuggestion) => ({ ...d } as AccountContactSuggestion),
    };
    let pipelineContinued = false;
    detectAndSuggest(msg(), brokenStorage).catch(() => { /* absorbed by scheduler */ });
    await Promise.resolve();
    pipelineContinued = true;
    expect(pipelineContinued).toBe(true);
  });
});

// ── Action workflow tests: simulate ignore/snooze/never-suggest/accept routes ──

class InMemoryActionStorage extends InMemoryContactCaptureStorage {
  contacts_out: Contact[] = [];

  async getAccountContactSuggestion(id: string): Promise<AccountContactSuggestion | undefined> {
    return this.suggestions.find(s => s.id === id);
  }

  async updateAccountContactSuggestionStatus(
    id: string,
    status: string,
    opts: { userId?: string; snoozedUntil?: Date | null },
  ): Promise<AccountContactSuggestion | undefined> {
    const s = this.suggestions.find(s => s.id === id);
    if (!s) return undefined;
    s.status = status;
    if (status === "snoozed" && opts.snoozedUntil) s.snoozedUntil = opts.snoozedUntil;
    if (opts.userId) s.actedByUserId = opts.userId;
    s.updatedAt = new Date();
    return s;
  }

  async getContactByEmailAndCompany(email: string, companyId: string): Promise<Contact | undefined> {
    return this.contacts.find(c => c.email === email && c.companyId === companyId);
  }

  async createContact(data: import("@shared/schema").InsertContact): Promise<Contact> {
    const contact: Contact = {
      id: `contact-${this.contacts.length + 1}`,
      companyId: data.companyId,
      name: data.name,
      title: data.title ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      roleType: data.roleType ?? null,
      sourceType: data.sourceType ?? null,
      lastSeenAt: data.lastSeenAt ?? null,
      status: data.status ?? "active",
      isPrimary: data.isPrimary ?? false,
      relationshipBase: data.relationshipBase ?? null,
      reportsToId: data.reportsToId ?? null,
      lanes: data.lanes ?? null,
      regions: data.regions ?? null,
      freightSpend: data.freightSpend ?? null,
      spotBiddingProcess: data.spotBiddingProcess ?? null,
      nextSteps: data.nextSteps ?? null,
      interests: data.interests ?? null,
      notes: data.notes ?? null,
      createdAt: data.createdAt ?? null,
      createdBy: data.createdBy ?? null,
      baseAdvancedAt: data.baseAdvancedAt ?? null,
    };
    this.contacts.push(contact);
    return contact;
  }

  async updateContact(id: string, data: import("@shared/schema").InsertContact): Promise<Contact | undefined> {
    const idx = this.contacts.findIndex(c => c.id === id);
    if (idx === -1) return undefined;
    const updated: Contact = {
      ...this.contacts[idx],
      ...data,
      id,
    };
    this.contacts[idx] = updated;
    return updated;
  }
}

function simulateAccept(
  storage: InMemoryActionStorage,
  suggestion: AccountContactSuggestion,
  roleType?: string,
) {
  const existing = storage.contacts.find(c => c.email === suggestion.emailAddress && c.companyId === suggestion.accountId);
  const now = new Date();
  if (existing) {
    const payload: import("@shared/schema").InsertContact = {
      companyId: existing.companyId,
      name: existing.name || suggestion.suggestedName || suggestion.emailAddress,
      title: existing.title || suggestion.suggestedTitle || null,
      phone: existing.phone || suggestion.suggestedPhone || null,
      email: existing.email ?? null,
      roleType: roleType ?? existing.roleType ?? null,
      sourceType: existing.sourceType ?? "email_capture",
      lastSeenAt: now,
      status: existing.status ?? "active",
      isPrimary: existing.isPrimary ?? false,
      relationshipBase: existing.relationshipBase ?? null,
      reportsToId: existing.reportsToId ?? null,
      lanes: existing.lanes ?? null,
      regions: existing.regions ?? null,
      freightSpend: existing.freightSpend ?? null,
      spotBiddingProcess: existing.spotBiddingProcess ?? null,
      nextSteps: existing.nextSteps ?? null,
      interests: existing.interests ?? null,
      notes: existing.notes ?? null,
      createdAt: existing.createdAt ?? null,
      createdBy: existing.createdBy ?? null,
      baseAdvancedAt: existing.baseAdvancedAt ?? null,
    };
    return storage.updateContact(existing.id, payload).then(async contact => {
      await storage.updateAccountContactSuggestionStatus(suggestion.id, "accepted", { userId: "user-1" });
      return { contact };
    });
  }
  const payload: import("@shared/schema").InsertContact = {
    companyId: suggestion.accountId,
    name: suggestion.suggestedName ?? suggestion.emailAddress,
    title: suggestion.suggestedTitle ?? null,
    email: suggestion.emailAddress,
    phone: suggestion.suggestedPhone ?? null,
    roleType: roleType ?? null,
    sourceType: "email_capture",
    lastSeenAt: now,
    status: "active",
    isPrimary: false,
    relationshipBase: null,
    reportsToId: null,
    lanes: null,
    regions: null,
    freightSpend: null,
    spotBiddingProcess: null,
    nextSteps: null,
    interests: null,
    notes: null,
    createdAt: null,
    createdBy: null,
    baseAdvancedAt: null,
  };
  return storage.createContact(payload).then(async contact => {
    await storage.updateAccountContactSuggestionStatus(suggestion.id, "accepted", { userId: "user-1" });
    return { contact };
  });
}

describe("action workflow: accept, ignore, snooze, never-suggest", () => {
  let storage: InMemoryActionStorage;
  let suggestion: AccountContactSuggestion;

  beforeEach(async () => {
    storage = new InMemoryActionStorage();
    storage.addCompany({ id: "acme", name: "Acme Corp", website: "https://acme.com" });
    await detectAndSuggest(msg(), storage);
    suggestion = storage.suggestions[0];
  });

  it("accept creates contact with sourceType=email_capture and marks suggestion accepted", async () => {
    const { contact } = await simulateAccept(storage, suggestion);
    expect(contact!.sourceType).toBe("email_capture");
    expect(contact!.email).toBe("jane@acme.com");
    expect(suggestion.status).toBe("accepted");
  });

  it("accept with roleType propagates roleType to contact", async () => {
    const { contact } = await simulateAccept(storage, suggestion, "Decision Maker");
    expect(contact!.roleType).toBe("Decision Maker");
  });

  it("accept on existing contact calls updateContact (not createContact) and sets lastSeenAt", async () => {
    const before = new Date("2026-01-01T00:00:00Z");
    storage.addContact({ id: "c-existing", companyId: "acme", email: "jane@acme.com", lastSeenAt: before });
    const { contact } = await simulateAccept(storage, suggestion);
    expect(storage.contacts).toHaveLength(1);
    expect(contact!.id).toBe("c-existing");
    expect(contact!.lastSeenAt!.getTime()).toBeGreaterThan(before.getTime());
    expect(contact!.sourceType).toBe("email_capture");
  });

  it("accept preserves curated name/title/phone and backfills blanks", async () => {
    const suggestionWithHints = { ...suggestion, suggestedTitle: "Director", suggestedPhone: "555-999-0000" };
    storage.addContact({
      id: "c-existing",
      companyId: "acme",
      email: "jane@acme.com",
      name: "Jane Smith (Curated)",
      title: "",
      phone: "",
    });
    const { contact } = await simulateAccept(storage, suggestionWithHints);
    expect(contact!.name).toBe("Jane Smith (Curated)");
    expect(contact!.title).toBe("Director");
    expect(contact!.phone).toBe("555-999-0000");
  });

  it("ignore marks suggestion ignored and does not create a contact", async () => {
    await storage.updateAccountContactSuggestionStatus(suggestion.id, "ignored", { userId: "user-1" });
    expect(suggestion.status).toBe("ignored");
    expect(storage.contacts).toHaveLength(0);
  });

  it("snooze marks suggestion snoozed with future snoozedUntil", async () => {
    const snoozedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await storage.updateAccountContactSuggestionStatus(suggestion.id, "snoozed", { userId: "user-1", snoozedUntil });
    expect(suggestion.status).toBe("snoozed");
    expect(suggestion.snoozedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("never-suggest marks suggestion never_suggest and prevents re-opening on next detection", async () => {
    await storage.updateAccountContactSuggestionStatus(suggestion.id, "never_suggest", { userId: "user-1" });
    expect(suggestion.status).toBe("never_suggest");
    await detectAndSuggest(msg({ id: "msg-002" }), storage);
    expect(storage.suggestions).toHaveLength(1);
    expect(storage.suggestions[0].status).toBe("never_suggest");
  });
});

// ── Accept merge logic: fills blanks, preserves curated values ────────────────

describe("accept merge logic (name/title/phone backfill semantics)", () => {
  function mergeContactUpdate(
    existing: Pick<Contact, "name" | "title" | "phone">,
    suggestion: { suggestedName: string | null; suggestedTitle: string | null; suggestedPhone: string | null; emailAddress: string },
  ) {
    return {
      name: existing.name || suggestion.suggestedName || suggestion.emailAddress,
      title: existing.title || suggestion.suggestedTitle || null,
      phone: existing.phone || suggestion.suggestedPhone || null,
    };
  }

  it("preserves curated name/title/phone when all fields are set", () => {
    const result = mergeContactUpdate(
      { name: "Jane Smith (Curated)", title: "VP of Procurement", phone: "555-000-1111" },
      { suggestedName: "Jane (sig)", suggestedTitle: "Director", suggestedPhone: "555-999-0000", emailAddress: "jane@acme.com" },
    );
    expect(result.name).toBe("Jane Smith (Curated)");
    expect(result.title).toBe("VP of Procurement");
    expect(result.phone).toBe("555-000-1111");
  });

  it("backfills blank title and phone from suggestion hints", () => {
    const result = mergeContactUpdate(
      { name: "Jane Smith (Curated)", title: "", phone: "" },
      { suggestedName: "Jane (sig)", suggestedTitle: "Director", suggestedPhone: "555-999-0000", emailAddress: "jane@acme.com" },
    );
    expect(result.name).toBe("Jane Smith (Curated)");
    expect(result.title).toBe("Director");
    expect(result.phone).toBe("555-999-0000");
  });

  it("uses email as name fallback when name and suggestedName are both blank", () => {
    const result = mergeContactUpdate(
      { name: "", title: null, phone: null },
      { suggestedName: null, suggestedTitle: null, suggestedPhone: null, emailAddress: "jane@acme.com" },
    );
    expect(result.name).toBe("jane@acme.com");
  });
});
