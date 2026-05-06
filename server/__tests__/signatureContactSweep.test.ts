/**
 * Signature Contact Sweep — Test Suite (Task #1055 / Email→Exec 4)
 *
 * Covers:
 *  1. parseSignatureBlock pulls name/title/phone/mobile/company from a
 *     well-formed signature.
 *  2. parseSignatureBlock returns all-nulls for an empty body.
 *  3. parseSignatureBlock confidence collapses to "none" when only HTML
 *     boilerplate is present.
 *  4. sweep skips when message is outbound.
 *  5. sweep skips when message has no linked company (unknown account).
 *  6. sweep ENRICHES an existing contact's null fields, never overwrites.
 *  7. sweep CREATES a new contact when high-confidence and sender absent.
 *  8. sweep falls back to suggestion queue when signature is too thin.
 *  9. sweep refuses to write across orgs (defence-in-depth).
 * 10. determineInitialOwner now PREFERS companies.ownerRepId over
 *     companies.assignedTo.
 * 11. determineInitialOwner falls back to assignedTo when ownerRepId is
 *     missing (legacy orgs).
 * 12. determineInitialOwner skips ownerRepId users that don't belong to
 *     the message's org (cross-tenant guard).
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseSignatureBlock } from "../services/signatureContactParser";
import { sweepSignatureContactForInbound } from "../services/signatureContactSweep";
import { determineInitialOwner } from "../services/conversationOwnershipService";
import type {
  EmailMessage,
  AccountContactSuggestion,
  Contact,
  InsertContact,
  InsertAccountContactSuggestion,
} from "@shared/schema";

// ── In-memory storage harness ─────────────────────────────────────────────────

interface MiniCompany {
  id: string;
  name: string;
  website: string | null;
  organizationId: string;
  ownerRepId: string | null;
  assignedTo: string | null;
}

interface MiniUser {
  id: string;
  organizationId: string;
}

class InMemoryStorage {
  private companies = new Map<string, MiniCompany>();
  private contacts: Contact[] = [];
  private users = new Map<string, MiniUser>();
  suggestions: AccountContactSuggestion[] = [];
  createdContacts: Contact[] = [];
  updatedContactPatches: Array<{ id: string; patch: InsertContact }> = [];
  private contactSeq = 0;

  addCompany(c: Partial<MiniCompany> & { id: string; name: string; organizationId: string }) {
    this.companies.set(c.id, {
      website: null,
      ownerRepId: null,
      assignedTo: null,
      ...c,
    });
    return this;
  }

  addContact(c: Partial<Contact> & { id: string; companyId: string; email: string; name: string }) {
    const full: Contact = {
      id: c.id,
      companyId: c.companyId,
      name: c.name,
      title: null,
      relationshipBase: null,
      email: c.email,
      phone: null,
      mobile: null,
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
    } as Contact;
    this.contacts.push(full);
    return this;
  }

  addUser(u: MiniUser) {
    this.users.set(u.id, u);
    return this;
  }

  // ── IStorage subset used by the sweep + ownership service ────────────────

  async getCompany(id: string): Promise<MiniCompany | undefined> {
    return this.companies.get(id);
  }

  async getUser(id: string): Promise<MiniUser | undefined> {
    return this.users.get(id);
  }

  async getContactsByCompany(companyId: string): Promise<Contact[]> {
    return this.contacts.filter(c => c.companyId === companyId);
  }

  async getContactByEmailAndCompany(email: string, companyId: string): Promise<Contact | undefined> {
    const lower = email.toLowerCase();
    return this.contacts.find(
      c => c.companyId === companyId && (c.email ?? "").toLowerCase() === lower,
    );
  }

  async createContact(data: InsertContact): Promise<Contact> {
    const id = `contact-new-${++this.contactSeq}`;
    const created: Contact = {
      id,
      companyId: data.companyId,
      name: data.name,
      title: data.title ?? null,
      relationshipBase: null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      mobile: data.mobile ?? null,
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
      sourceType: data.sourceType ?? null,
      roleType: null,
      status: data.status ?? "active",
      isPrimary: data.isPrimary ?? false,
    } as Contact;
    this.contacts.push(created);
    this.createdContacts.push(created);
    return created;
  }

  async updateContact(id: string, patch: InsertContact): Promise<Contact | undefined> {
    const idx = this.contacts.findIndex(c => c.id === id);
    if (idx < 0) return undefined;
    this.updatedContactPatches.push({ id, patch });
    const merged = { ...this.contacts[idx], ...patch } as Contact;
    this.contacts[idx] = merged;
    return merged;
  }

  async upsertAccountContactSuggestion(
    data: InsertAccountContactSuggestion,
  ): Promise<AccountContactSuggestion> {
    const existing = this.suggestions.find(
      s => s.accountId === data.accountId && s.emailAddress === data.emailAddress,
    );
    if (existing) return existing;
    const created: AccountContactSuggestion = {
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
    this.suggestions.push(created);
    return created;
  }
}

function makeMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "msg-001",
    orgId: "org-001",
    threadId: "thread-abc",
    direction: "inbound",
    fromEmail: "jane@acme.com",
    toEmail: "rep@freight.co",
    ccEmail: null,
    subject: "Quote needed for next week",
    body:
      "Hi rep,\n\nCan you cover this lane?\n\nThanks,\n--\nJane Smith\nDirector of Logistics, Acme Corp\nO: 555-123-4567\nM: 555-987-6543",
    linkedAccountId: "acme",
    linkedCarrierId: null,
    linkedLaneId: null,
    linkedLoadId: null,
    linkedTaskId: null,
    linkedNbaId: null,
    linkedOutreachLogId: null,
    processedForSignalsAt: null,
    createdAt: new Date("2026-05-01T10:00:00Z"),
    providerMessageId: "graph-001",
    ...overrides,
  } as EmailMessage;
}

function baseStorage(): InMemoryStorage {
  return new InMemoryStorage().addCompany({
    id: "acme",
    name: "Acme Corp",
    website: "https://acme.com",
    organizationId: "org-001",
    ownerRepId: null,
  });
}

// ── parseSignatureBlock ───────────────────────────────────────────────────────

describe("parseSignatureBlock", () => {
  it("extracts name, title, phone and mobile from a standard sign-off", () => {
    const body =
      "Hi rep,\nLooking for a quote.\n\nThanks,\n--\nJane Smith\nDirector of Logistics\nO: 555-123-4567\nM: 555-987-6543";
    const parsed = parseSignatureBlock(body, "jane@acme.com");
    expect(parsed.name).toBe("Jane Smith");
    expect(parsed.title?.toLowerCase()).toContain("director");
    expect(parsed.phone).toMatch(/555-123-4567/);
    expect(parsed.mobile).toMatch(/555-987-6543/);
    expect(parsed.confidence).toBe("high");
  });

  it("returns all-null low/none when body is empty or whitespace", () => {
    const empty = parseSignatureBlock("", "j@x.com");
    expect(empty.name).toBeNull();
    expect(empty.phone).toBeNull();
    expect(empty.confidence).toBe("none");

    const nullBody = parseSignatureBlock(null, "j@x.com");
    expect(nullBody.confidence).toBe("none");
  });

  it("survives html-only marketing footer with no signal", () => {
    const html = "<html><body><p>Promotional text only</p></body></html>";
    const parsed = parseSignatureBlock(html, "j@x.com");
    expect(parsed.name).toBeNull();
    expect(parsed.phone).toBeNull();
    expect(["none", "low"]).toContain(parsed.confidence);
  });
});

// ── sweepSignatureContactForInbound ───────────────────────────────────────────

describe("sweepSignatureContactForInbound", () => {
  let storage: InMemoryStorage;
  beforeEach(() => {
    storage = baseStorage();
  });

  it("skips outbound messages", async () => {
    const result = await sweepSignatureContactForInbound(
      makeMessage({ direction: "outbound" }),
      storage as any,
    );
    expect(result.action).toBe("skipped_outbound");
    expect(storage.createdContacts).toHaveLength(0);
  });

  it("skips when no linked company (unknown account)", async () => {
    const result = await sweepSignatureContactForInbound(
      makeMessage({ linkedAccountId: null }),
      storage as any,
    );
    expect(result.action).toBe("skipped_no_company");
    expect(storage.createdContacts).toHaveLength(0);
    expect(storage.suggestions).toHaveLength(0);
  });

  it("creates a new contact when high-confidence signature + sender absent", async () => {
    const result = await sweepSignatureContactForInbound(makeMessage(), storage as any);
    expect(result.action).toBe("created");
    expect(storage.createdContacts).toHaveLength(1);
    const c = storage.createdContacts[0];
    expect(c.companyId).toBe("acme");
    expect(c.email).toBe("jane@acme.com");
    expect(c.name).toBe("Jane Smith");
    expect(c.sourceType).toBe("email_signature");
    expect(c.phone).toMatch(/555-123-4567/);
    expect(c.mobile).toMatch(/555-987-6543/);
  });

  it("enriches null fields on an existing contact and never overwrites filled ones", async () => {
    storage.addContact({
      id: "contact-existing",
      companyId: "acme",
      email: "jane@acme.com",
      name: "jane@acme.com", // email-derived placeholder name
      title: "VP of Pricing", // ALREADY SET — must not be overwritten
      phone: null,
      mobile: null,
    });
    const result = await sweepSignatureContactForInbound(makeMessage(), storage as any);
    expect(result.action).toBe("enriched");
    expect(result.contactId).toBe("contact-existing");
    expect(storage.createdContacts).toHaveLength(0);
    const patch = storage.updatedContactPatches[0].patch as InsertContact;
    expect(patch.title).toBe("VP of Pricing"); // preserved
    expect(patch.phone).toMatch(/555-123-4567/);
    expect(patch.mobile).toMatch(/555-987-6543/);
    expect(patch.name).toBe("Jane Smith"); // placeholder upgraded
  });

  it("never creates a duplicate when sender already mapped to a contact under the company", async () => {
    // Reviewer ask: "sender already known via contact mapping precedence
    // over domain match — prove no duplicate contact creation across
    // known accounts." The sweep MUST short-circuit on the existing
    // (companyId, email) row and either enrich or noop — never create.
    storage.addContact({
      id: "contact-already-mapped",
      companyId: "acme",
      email: "jane@acme.com",
      name: "Jane Smith",
      title: "Director of Logistics",
      phone: "555-123-4567",
      mobile: "555-987-6543",
    });
    const result = await sweepSignatureContactForInbound(makeMessage(), storage as any);
    expect(["enriched", "noop_existing_complete"]).toContain(result.action);
    expect(result.contactId).toBe("contact-already-mapped");
    expect(storage.createdContacts).toHaveLength(0);
  });

  it("returns noop when existing contact already complete", async () => {
    storage.addContact({
      id: "contact-complete",
      companyId: "acme",
      email: "jane@acme.com",
      name: "Jane Smith",
      title: "Director",
      phone: "555-000-0000",
      mobile: "555-111-1111",
    });
    const result = await sweepSignatureContactForInbound(makeMessage(), storage as any);
    expect(result.action).toBe("noop_existing_complete");
    expect(storage.updatedContactPatches).toHaveLength(0);
  });

  it("falls back to suggestion queue when signature is too thin", async () => {
    const thinMsg = makeMessage({
      // No name, no phone — just a sign-off line.
      body: "Thanks for the quick reply!\n\n--\nSee attached PO\n",
    });
    const result = await sweepSignatureContactForInbound(thinMsg, storage as any);
    expect(["suggested", "skipped_no_signal"]).toContain(result.action);
    expect(storage.createdContacts).toHaveLength(0);
  });

  it("enriches a THIN existing contact (placeholder name + null title/phone)", async () => {
    // The most important thin-contact case: the sender already maps to a
    // contact (so the integration gate `!accountMatch.contactId` would
    // have skipped this in the v1 plan), but the contact is a thin
    // placeholder with no title and no phone. The sweep MUST still run
    // and fill the null fields.
    storage.addContact({
      id: "contact-thin",
      companyId: "acme",
      email: "jane@acme.com",
      name: "jane@acme.com", // email-derived placeholder
      title: null,
      phone: null,
      mobile: null,
    });
    const result = await sweepSignatureContactForInbound(makeMessage(), storage as any);
    expect(result.action).toBe("enriched");
    expect(result.contactId).toBe("contact-thin");
    const patch = storage.updatedContactPatches[0].patch as InsertContact;
    expect(patch.title?.toLowerCase()).toContain("director");
    expect(patch.phone).toMatch(/555-123-4567/);
    expect(patch.mobile).toMatch(/555-987-6543/);
    expect(patch.name).toBe("Jane Smith");
  });

  it("refuses to write across orgs even if a wrong companyId is forced", async () => {
    // Caller passes a companyId from a different org. The cross-tenant
    // guard must short-circuit before any contact write.
    storage.addCompany({
      id: "other-co",
      name: "Other Inc",
      organizationId: "org-OTHER",
    });
    const result = await sweepSignatureContactForInbound(
      makeMessage({ orgId: "org-001" }),
      storage as any,
      { companyId: "other-co" },
    );
    expect(result.action).toBe("skipped_no_company");
    expect(storage.createdContacts).toHaveLength(0);
    expect(storage.suggestions).toHaveLength(0);
  });
});

// ── determineInitialOwner — Task #1055 ownerRepId precedence ─────────────────

describe("determineInitialOwner — ownerRepId precedence", () => {
  it("prefers companies.ownerRepId over companies.assignedTo", async () => {
    const storage = new InMemoryStorage()
      .addCompany({
        id: "acme",
        name: "Acme Corp",
        organizationId: "org-001",
        ownerRepId: "user-owner-rep",
        assignedTo: "user-legacy-assigned",
      })
      .addUser({ id: "user-owner-rep", organizationId: "org-001" })
      .addUser({ id: "user-legacy-assigned", organizationId: "org-001" });

    const ownerId = await determineInitialOwner(
      makeMessage({ linkedAccountId: "acme" }),
      "org-001",
      storage as any,
    );
    expect(ownerId).toBe("user-owner-rep");
  });

  it("falls back to assignedTo when ownerRepId is missing", async () => {
    const storage = new InMemoryStorage()
      .addCompany({
        id: "acme",
        name: "Acme Corp",
        organizationId: "org-001",
        ownerRepId: null,
        assignedTo: "user-legacy-assigned",
      })
      .addUser({ id: "user-legacy-assigned", organizationId: "org-001" });

    const ownerId = await determineInitialOwner(
      makeMessage({ linkedAccountId: "acme" }),
      "org-001",
      storage as any,
    );
    expect(ownerId).toBe("user-legacy-assigned");
  });

  it("falls through to next candidate when ownerRepId user is in a different org", async () => {
    const storage = new InMemoryStorage()
      .addCompany({
        id: "acme",
        name: "Acme Corp",
        organizationId: "org-001",
        ownerRepId: "user-foreign",
        assignedTo: "user-legacy-assigned",
      })
      .addUser({ id: "user-foreign", organizationId: "org-OTHER" })
      .addUser({ id: "user-legacy-assigned", organizationId: "org-001" });

    const ownerId = await determineInitialOwner(
      makeMessage({ linkedAccountId: "acme" }),
      "org-001",
      storage as any,
    );
    expect(ownerId).toBe("user-legacy-assigned");
  });

  it("returns null when no linked account", async () => {
    const storage = new InMemoryStorage();
    const ownerId = await determineInitialOwner(
      makeMessage({ linkedAccountId: null, direction: "inbound" }),
      "org-001",
      storage as any,
    );
    expect(ownerId).toBeNull();
  });
});

// ── Integration-gate guardrail (Task #1055 review fix) ──────────────────────
// Pin the gate condition in `processUserMailboxEmail` so a future refactor
// can't reintroduce the v1 bug where the sweep was skipped for known senders
// already mapped to a thin/placeholder contact.

describe("processUserMailboxEmail integration gate (Task #1055)", () => {
  const webhookSrc = fs.readFileSync(
    path.resolve(__dirname, "../routes/graphWebhook.ts"),
    "utf8",
  );

  it("invokes the signature sweep from the user-mailbox ingest path", () => {
    expect(webhookSrc).toMatch(/sweepSignatureContactForInbound\s*\(/);
    expect(webhookSrc).toMatch(/["']\.\.\/services\/signatureContactSweep["']/);
  });

  it("does NOT gate the sweep on `!accountMatch.contactId` (must run for thin existing contacts too)", () => {
    // Locate the actual `if (...)` gate that wraps the sweep call. We
    // inspect only the condition expression and the body up to the
    // sweep call, NOT the leading comment block (which intentionally
    // mentions `!accountMatch.contactId` to explain why the gate was
    // changed).
    const gateMatch = webhookSrc.match(
      /\n\s*if\s*\(([\s\S]{0,400}?)\)\s*\{\s*try\s*\{[\s\S]{0,400}?sweepSignatureContactForInbound/,
    );
    expect(gateMatch).not.toBeNull();
    const condition = gateMatch![1];
    expect(condition).not.toMatch(/!accountMatch\.contactId/);
    expect(condition).toMatch(/direction\s*===\s*["']inbound["']/);
    expect(condition).toMatch(/accountMatch\?\.companyId/);
  });
});

// ── Quote-ingestion canonical-owner guardrail (Task #1055 / Task #1011) ────
// Pin that the email→quote pipeline reads canonical companies.ownerRepId
// (via resolveCustomerIdentityForEmail) when attributing the rep on a
// freshly-ingested quote. The signature sweep above only fills the
// upstream contact + company link; quote attribution then flows through
// this canonical chain. If a future refactor drops that fallback, quotes
// from sender-domain-matched accounts will silently land Unassigned.

describe("quoteEmailIngestion — canonical owner attribution (Task #1055)", () => {
  const ingestionSrc = fs.readFileSync(
    path.resolve(__dirname, "../services/quoteEmailIngestion.ts"),
    "utf8",
  );
  const storageSrc = fs.readFileSync(
    path.resolve(__dirname, "../storage.ts"),
    "utf8",
  );

  it("calls resolveCustomerIdentityForEmail before assigning a rep", () => {
    expect(ingestionSrc).toMatch(/storage\.resolveCustomerIdentityForEmail\s*\(/);
  });

  it("falls back to identityHit.ownerRepId when inbox-recipient lookup misses", () => {
    expect(ingestionSrc).toMatch(/identityHit\?\.ownerRepId/);
    expect(ingestionSrc).toMatch(/findOrCreateRepByUserId\s*\(\s*message\.orgId\s*,\s*identityHit\.ownerRepId/);
  });

  it("resolveCustomerIdentityForEmail selects companies.ownerRepId (canonical column)", () => {
    expect(storageSrc).toMatch(/ownerRepId:\s*companies\.ownerRepId/);
  });
});

// ── Owner attribution guardrail (Task #1055 / CQ-3 read-only contract) ─────

describe("conversationOwnershipService — read-only owner attribution (Task #1055)", () => {
  const ownershipSrc = fs.readFileSync(
    path.resolve(__dirname, "../services/conversationOwnershipService.ts"),
    "utf8",
  );

  it("reads companies.ownerRepId before companies.assignedTo", () => {
    const ownerRepIdx = ownershipSrc.indexOf("company?.ownerRepId");
    const assignedToIdx = ownershipSrc.indexOf("company.assignedTo");
    expect(ownerRepIdx).toBeGreaterThan(-1);
    expect(assignedToIdx).toBeGreaterThan(-1);
    expect(ownerRepIdx).toBeLessThan(assignedToIdx);
  });

  it("never writes to companies.ownerRepId or companies.assignedTo (CQ-3)", () => {
    expect(ownershipSrc).not.toMatch(/updateCompany|update\(\s*companies\b/);
    expect(ownershipSrc).not.toMatch(/companies\.ownerRepId\s*[,=]\s*[^?]/);
  });
});
