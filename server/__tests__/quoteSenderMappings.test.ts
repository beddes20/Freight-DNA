/**
 * Customer Quotes #3 — sender-domain learning service tests.
 *
 * Drives `extractSenderInfo`, `lookupMapping`, `upsertManualMapping`,
 * and `learnFromReassign` against an in-memory db mock that mirrors
 * the partial-unique behaviour of the real schema.
 *
 * Behaviours under test:
 *   - extractSenderInfo: returns null for malformed / empty inputs;
 *     correctly tags free-mail vs business-domain senders
 *   - lookupMapping: email match wins over domain match; free-mail
 *     senders DO NOT fall back to a domain match (gmail collision guard)
 *   - upsertManualMapping: business-domain → domain row, free-mail →
 *     email row; second call updates the existing row instead of
 *     duplicating; refuses Unknown / carrier targets
 *   - learnFromReassign: looks up the source email and upserts in one
 *     shot; swallows errors so reassign never rolls back
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const ORG = "org-A";
const OTHER_ORG = "org-B";
const UNKNOWN_BUCKET_ID = "cust-unknown";
const REAL_CUSTOMER_ID = "cust-real";
const SECOND_CUSTOMER_ID = "cust-second";
const CARRIER_CUSTOMER_ID = "cust-carrier";

interface MappingRow {
  id: string;
  organizationId: string;
  senderDomain: string | null;
  senderEmail: string | null;
  customerId: string;
  source: string;
  sampleCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
interface CustomerRow {
  id: string;
  organizationId: string;
  name: string;
  partyType: string;
}
interface EmailRow {
  id: string;
  orgId: string;
  providerMessageId: string | null;
  fromEmail: string | null;
}

const state = vi.hoisted(() => ({
  mappings: [] as MappingRow[],
  customers: [] as CustomerRow[],
  emails: [] as EmailRow[],
  nextId: 1,
}));

vi.mock("../storage", async () => {
  const schema: any = await import("@shared/schema");

  const buildChain = (rows: any[]) => {
    const p: any = Promise.resolve(rows);
    p.orderBy = () => Promise.resolve(rows);
    p.limit = () => Promise.resolve(rows);
    return p;
  };

  return {
    db: {
      select: (cols?: any) => ({
        from: (table: any) => ({
          // listMappings() does .from(quoteSenderMappings).innerJoin(quoteCustomers, ...).where(eq(org)).orderBy()
          // Mock returns the joined org-scoped rows in lastUsedAt-desc order so
          // tests can assert on customer-name + org-scoping behaviour.
          innerJoin: (_other: any, _on: any) => ({
            where: (pred: any) => {
              const text = collectLiterals(pred);
              const orgId = text.has(ORG) ? ORG : text.has(OTHER_ORG) ? OTHER_ORG : null;
              const rows = state.mappings
                .filter(m => orgId ? m.organizationId === orgId : true)
                .map(m => {
                  const cust = state.customers.find(c => c.id === m.customerId);
                  return { ...m, customerName: cust?.name ?? "" };
                })
                .sort((a, b) => (b.lastUsedAt?.getTime() ?? 0) - (a.lastUsedAt?.getTime() ?? 0));
              return buildChain(rows);
            },
          }),
          where: (pred: any) => {
            const text = collectLiterals(pred);
            const orgId = text.has(ORG) ? ORG : text.has(OTHER_ORG) ? OTHER_ORG : null;

            if (table === schema.quoteSenderMappings) {
              const rows = state.mappings.filter(r => {
                if (orgId && r.organizationId !== orgId) return false;
                if (text.size > 1) {
                  // require at least one matching field: id / domain / email
                  const candidates = [r.id, r.senderDomain ?? "", r.senderEmail ?? ""];
                  const matched = candidates.some(v => v && text.has(v));
                  if (!matched) return false;
                }
                return true;
              });
              return buildChain(rows.slice(0, rows.length));
            }
            if (table === schema.quoteCustomers) {
              const rows = state.customers.filter(c => {
                if (orgId && c.organizationId !== orgId) return false;
                if (text.size > 1) {
                  const matched = text.has(c.id);
                  if (!matched) return false;
                }
                return true;
              });
              return buildChain(rows);
            }
            if (table === schema.emailMessages) {
              const rows = state.emails.filter(e => {
                if (orgId && e.orgId !== orgId) return false;
                const candidates = [e.id, e.providerMessageId ?? ""];
                return candidates.some(v => v && text.has(v));
              }).map(e => ({ fromEmail: e.fromEmail }));
              return buildChain(rows);
            }
            return buildChain([]);
          },
        }),
      }),
      insert: (table: any) => ({
        values: (vals: any) => {
          const insertRow = (): MappingRow | null => {
            if (table !== schema.quoteSenderMappings) return null;
            // Simulate the partial unique indexes: a duplicate (org, email)
            // when sender_email is non-null, or (org, domain) when
            // sender_domain is non-null, would raise — return the existing
            // row from the test fixture so the mock callers can detect it.
            const dupe = state.mappings.find(r =>
              r.organizationId === vals.organizationId && (
                (vals.senderEmail && r.senderEmail === vals.senderEmail) ||
                (vals.senderDomain && r.senderDomain === vals.senderDomain)
              ),
            );
            if (dupe) return null;
            const row: MappingRow = {
              id: `map-${state.nextId++}`,
              organizationId: vals.organizationId,
              senderDomain: vals.senderDomain ?? null,
              senderEmail: vals.senderEmail ?? null,
              customerId: vals.customerId,
              source: vals.source ?? "manual",
              sampleCount: vals.sampleCount ?? 1,
              lastUsedAt: vals.lastUsedAt ?? new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            state.mappings.push(row);
            return row;
          };
          // Plain `.returning()` chain (used by other code paths).
          const directReturning = () => {
            const row = insertRow();
            return Promise.resolve(row ? [row] : []);
          };
          return {
            returning: directReturning,
            // Drizzle's onConflictDoUpdate({ target, targetWhere, set }).
            onConflictDoUpdate: (_args: any) => ({
              returning: () => {
                if (table !== schema.quoteSenderMappings) {
                  return Promise.resolve([]);
                }
                // Try insert; if it would conflict (duplicate found), simulate the
                // DO UPDATE: bump sample_count, swap customer_id, refresh timestamps.
                const dupe = state.mappings.find(r =>
                  r.organizationId === vals.organizationId && (
                    (vals.senderEmail && r.senderEmail === vals.senderEmail) ||
                    (vals.senderDomain && r.senderDomain === vals.senderDomain)
                  ),
                );
                if (dupe) {
                  dupe.customerId = vals.customerId;
                  dupe.sampleCount = dupe.sampleCount + 1;
                  dupe.lastUsedAt = vals.lastUsedAt ?? new Date();
                  dupe.updatedAt = vals.updatedAt ?? new Date();
                  dupe.source = vals.source ?? dupe.source;
                  return Promise.resolve([dupe]);
                }
                const row = insertRow();
                return Promise.resolve(row ? [row] : []);
              },
            }),
          };
        },
      }),
      update: (table: any) => ({
        set: (setVals: any) => ({
          where: (pred: any) => {
            const text = collectLiterals(pred);
            const ret = {
              returning: () => Promise.resolve(applyUpdate(table, schema, text, setVals)),
            };
            const matchedCount = applyUpdate(table, schema, text, setVals).length;
            return Object.assign(Promise.resolve(matchedCount), ret);
          },
        }),
      }),
      delete: (table: any) => ({
        where: (pred: any) => {
          const text = collectLiterals(pred);
          const ret = {
            returning: () => {
              if (table === schema.quoteSenderMappings) {
                const before = state.mappings.length;
                const removed = state.mappings.filter(r => text.has(r.id) && (text.has(ORG) ? r.organizationId === ORG : text.has(OTHER_ORG) ? r.organizationId === OTHER_ORG : true));
                state.mappings = state.mappings.filter(r => !removed.includes(r));
                return Promise.resolve(removed.map(r => ({ id: r.id })));
              }
              return Promise.resolve([]);
            },
          };
          return ret;
        },
      }),
    },
    storage: {},
  };
});

function applyUpdate(table: any, schema: any, text: Set<string>, setVals: any): MappingRow[] {
  if (table !== schema.quoteSenderMappings) return [];
  const matched = state.mappings.filter(r => text.has(r.id));
  for (const r of matched) {
    if (setVals.customerId !== undefined) r.customerId = setVals.customerId;
    if (setVals.source !== undefined) r.source = setVals.source;
    if (setVals.lastUsedAt !== undefined) r.lastUsedAt = setVals.lastUsedAt;
    if (setVals.updatedAt !== undefined) r.updatedAt = setVals.updatedAt;
    // sample_count uses sql`... + 1` — we cannot evaluate SQL chunks, so
    // detect the increment shape (drizzle SQL object) and bump in-place.
    if (setVals.sampleCount !== undefined) r.sampleCount += 1;
  }
  return matched;
}

function collectLiterals(node: any, acc: Set<string> = new Set(), seen: WeakSet<object> = new WeakSet()): Set<string> {
  if (node == null) return acc;
  if (typeof node === "string") { acc.add(node); return acc; }
  if (typeof node !== "object") return acc;
  if (seen.has(node)) return acc;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const v of node) collectLiterals(v, acc, seen);
    return acc;
  }
  for (const v of Object.values(node)) collectLiterals(v, acc, seen);
  return acc;
}

function seed() {
  state.mappings = [];
  state.customers = [
    { id: UNKNOWN_BUCKET_ID, organizationId: ORG, name: "Unknown — needs review", partyType: "unknown" },
    { id: REAL_CUSTOMER_ID, organizationId: ORG, name: "Acme Logistics", partyType: "customer" },
    { id: SECOND_CUSTOMER_ID, organizationId: ORG, name: "Globex Freight", partyType: "customer" },
    { id: CARRIER_CUSTOMER_ID, organizationId: ORG, name: "Bigrig Carrier Co", partyType: "carrier" },
  ];
  state.emails = [];
  state.nextId = 1;
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe("extractSenderInfo", () => {
  it("returns null for empty / malformed input", async () => {
    const { extractSenderInfo } = await import("../services/quoteSenderMappings");
    expect(extractSenderInfo(null)).toBeNull();
    expect(extractSenderInfo("")).toBeNull();
    expect(extractSenderInfo("not-an-email")).toBeNull();
  });

  it("tags free-mail vs business-domain senders", async () => {
    const { extractSenderInfo } = await import("../services/quoteSenderMappings");
    const biz = extractSenderInfo("buyer@acme.com");
    expect(biz?.domain).toBe("acme.com");
    expect(biz?.isFreeMail).toBe(false);
    const free = extractSenderInfo("Personal <jane@gmail.com>");
    expect(free?.domain).toBe("gmail.com");
    expect(free?.isFreeMail).toBe(true);
  });
});

describe("upsertManualMapping", () => {
  it("creates a domain-level row for a business sender", async () => {
    const { upsertManualMapping } = await import("../services/quoteSenderMappings");
    const result = await upsertManualMapping(ORG, "ops@acme.com", REAL_CUSTOMER_ID);
    expect(result.status).toBe("created");
    expect(state.mappings).toHaveLength(1);
    expect(state.mappings[0].senderDomain).toBe("acme.com");
    expect(state.mappings[0].senderEmail).toBeNull();
    expect(state.mappings[0].customerId).toBe(REAL_CUSTOMER_ID);
  });

  it("creates an email-level row for a free-mail sender", async () => {
    const { upsertManualMapping } = await import("../services/quoteSenderMappings");
    const result = await upsertManualMapping(ORG, "jane@gmail.com", REAL_CUSTOMER_ID);
    expect(result.status).toBe("created");
    expect(state.mappings).toHaveLength(1);
    expect(state.mappings[0].senderEmail).toBe("jane@gmail.com");
    expect(state.mappings[0].senderDomain).toBeNull();
  });

  it("updates the existing row on a second call (no duplicate)", async () => {
    const { upsertManualMapping } = await import("../services/quoteSenderMappings");
    const first = await upsertManualMapping(ORG, "ops@acme.com", REAL_CUSTOMER_ID);
    expect(first.status).toBe("created");
    const second = await upsertManualMapping(ORG, "different@acme.com", SECOND_CUSTOMER_ID);
    expect(second.status).toBe("updated");
    expect(state.mappings).toHaveLength(1);
    expect(state.mappings[0].customerId).toBe(SECOND_CUSTOMER_ID);
    expect(state.mappings[0].sampleCount).toBe(2);
  });

  it("refuses to learn when the target is the Unknown bucket", async () => {
    const { upsertManualMapping } = await import("../services/quoteSenderMappings");
    const result = await upsertManualMapping(ORG, "ops@acme.com", UNKNOWN_BUCKET_ID);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("unknown_target");
    expect(state.mappings).toHaveLength(0);
  });

  it("refuses to learn when the target is a carrier party_type", async () => {
    const { upsertManualMapping } = await import("../services/quoteSenderMappings");
    const result = await upsertManualMapping(ORG, "ops@acme.com", CARRIER_CUSTOMER_ID);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("carrier_target");
    expect(state.mappings).toHaveLength(0);
  });

  it("refuses to learn when the target customer doesn't exist", async () => {
    const { upsertManualMapping } = await import("../services/quoteSenderMappings");
    const result = await upsertManualMapping(ORG, "ops@acme.com", "cust-missing");
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("missing_target");
  });

  it("skips silently when the from-email is unparseable", async () => {
    const { upsertManualMapping } = await import("../services/quoteSenderMappings");
    const result = await upsertManualMapping(ORG, "", REAL_CUSTOMER_ID);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_email");
  });
});

describe("lookupMapping", () => {
  it("returns null when no mapping exists for the sender", async () => {
    const { lookupMapping } = await import("../services/quoteSenderMappings");
    const got = await lookupMapping(ORG, "ops@acme.com");
    expect(got).toBeNull();
  });

  it("finds a domain mapping for a business sender", async () => {
    const { upsertManualMapping, lookupMapping } = await import("../services/quoteSenderMappings");
    await upsertManualMapping(ORG, "ops@acme.com", REAL_CUSTOMER_ID);
    const got = await lookupMapping(ORG, "newperson@acme.com");
    expect(got?.customerId).toBe(REAL_CUSTOMER_ID);
    expect(got?.senderDomain).toBe("acme.com");
  });

  it("does NOT fall back to domain match for a free-mail sender", async () => {
    const { upsertManualMapping, lookupMapping } = await import("../services/quoteSenderMappings");
    // Seed an email-level free-mail mapping for jane@gmail.com.
    await upsertManualMapping(ORG, "jane@gmail.com", REAL_CUSTOMER_ID);
    // Different gmail user — must NOT match jane's mapping.
    const got = await lookupMapping(ORG, "bob@gmail.com");
    expect(got).toBeNull();
  });

  it("email match wins over domain match", async () => {
    const { upsertManualMapping, lookupMapping } = await import("../services/quoteSenderMappings");
    // Seed a domain mapping for acme.com (manual).
    await upsertManualMapping(ORG, "ops@acme.com", REAL_CUSTOMER_ID);
    // Inject an email-specific override row directly into state.
    state.mappings.push({
      id: "map-email-override",
      organizationId: ORG,
      senderDomain: null,
      senderEmail: "vip@acme.com",
      customerId: SECOND_CUSTOMER_ID,
      source: "manual",
      sampleCount: 1,
      lastUsedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const got = await lookupMapping(ORG, "vip@acme.com");
    expect(got?.customerId).toBe(SECOND_CUSTOMER_ID);
  });
});

describe("listMappings (org scoping)", () => {
  it("returns only the calling org's mappings, with customer name", async () => {
    const { upsertManualMapping, listMappings } = await import("../services/quoteSenderMappings");
    // Seed an OTHER_ORG customer + mapping so we can verify it's filtered out.
    state.customers.push({
      id: "cust-otherorg-real",
      organizationId: OTHER_ORG,
      name: "Other Org Co",
      partyType: "customer",
    });
    await upsertManualMapping(ORG, "buyer@acme.com", REAL_CUSTOMER_ID);
    await upsertManualMapping(OTHER_ORG, "buyer@otherorg.com", "cust-otherorg-real");

    const orgRows = await listMappings(ORG);
    expect(orgRows).toHaveLength(1);
    expect(orgRows[0].senderDomain).toBe("acme.com");
    expect(orgRows[0].customerName).toBe("Acme Logistics");
    // The OTHER_ORG row must not bleed into ORG's view.
    expect(orgRows.find(r => r.senderDomain === "otherorg.com")).toBeUndefined();
  });
});

describe("deleteMapping (org scoping)", () => {
  it("refuses to delete a mapping that belongs to another org", async () => {
    const { upsertManualMapping, deleteMapping } = await import("../services/quoteSenderMappings");
    state.customers.push({
      id: "cust-otherorg-real",
      organizationId: OTHER_ORG,
      name: "Other Org Co",
      partyType: "customer",
    });
    await upsertManualMapping(OTHER_ORG, "buyer@otherorg.com", "cust-otherorg-real");
    expect(state.mappings).toHaveLength(1);
    const otherOrgMapping = state.mappings[0];

    // ORG admin tries to delete OTHER_ORG's mapping by id alone.
    const result = await deleteMapping(ORG, otherOrgMapping.id);
    expect(result.deleted).toBe(false);
    // The other-org row must still exist — no cross-tenant deletion.
    expect(state.mappings).toHaveLength(1);
  });

  it("deletes a mapping belonging to the calling org", async () => {
    const { upsertManualMapping, deleteMapping } = await import("../services/quoteSenderMappings");
    await upsertManualMapping(ORG, "buyer@acme.com", REAL_CUSTOMER_ID);
    const created = state.mappings[0];
    const result = await deleteMapping(ORG, created.id);
    expect(result.deleted).toBe(true);
    expect(state.mappings).toHaveLength(0);
  });
});

describe("learnFromReassign", () => {
  it("finds the source email by providerMessageId and upserts a mapping", async () => {
    state.emails.push({
      id: "msg-internal-1",
      orgId: ORG,
      providerMessageId: "graph-99",
      fromEmail: "buyer@globex.com",
    });
    const { learnFromReassign } = await import("../services/quoteSenderMappings");
    const result = await learnFromReassign(ORG, "graph-99", REAL_CUSTOMER_ID);
    expect(result.status).toBe("created");
    expect(state.mappings).toHaveLength(1);
    expect(state.mappings[0].senderDomain).toBe("globex.com");
  });

  it("falls back to internal id when providerMessageId is not the ref", async () => {
    state.emails.push({
      id: "msg-internal-2",
      orgId: ORG,
      providerMessageId: null,
      fromEmail: "buyer@bigco.com",
    });
    const { learnFromReassign } = await import("../services/quoteSenderMappings");
    const result = await learnFromReassign(ORG, "msg-internal-2", REAL_CUSTOMER_ID);
    expect(result.status).toBe("created");
    expect(state.mappings[0].senderDomain).toBe("bigco.com");
  });

  it("returns skipped when the source reference resolves to no email", async () => {
    const { learnFromReassign } = await import("../services/quoteSenderMappings");
    const result = await learnFromReassign(ORG, "missing-ref", REAL_CUSTOMER_ID);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_email");
    expect(state.mappings).toHaveLength(0);
  });

  it("returns skipped (never throws) when sourceReference is null", async () => {
    const { learnFromReassign } = await import("../services/quoteSenderMappings");
    const result = await learnFromReassign(ORG, null, REAL_CUSTOMER_ID);
    expect(result.status).toBe("skipped");
  });
});
