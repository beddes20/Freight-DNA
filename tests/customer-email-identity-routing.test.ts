/**
 * Task #1011 — proof case for customer email identity routing.
 *
 * Validates the assignment-precedence chain end-to-end against a live
 * Postgres database:
 *   contact → shared_distribution → domain → owner-rep fallback → null.
 *
 * Also pins the `buildAttributionResponse` helper's identity-aware
 * rule names so the Quote-Requests "Why this rep?" drawer renders the
 * right reason for each match.
 */
import { db, storage } from "../server/storage";
import {
  organizations,
  companies,
  customerEmailIdentities,
  users,
} from "../shared/schema";
import { buildAttributionResponse } from "../server/routes/customerQuotes";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function expectEq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label} — expected ${b} got ${a}`); failures.push(label); failed++; }
}

console.log("══════════════════════════════════════════════════════════════");
console.log("  Customer Email Identity Routing — Task #1011");
console.log("══════════════════════════════════════════════════════════════");

const orgId = randomUUID();
const ownerRepId = randomUUID();
const otherOrgId = randomUUID();

async function setup() {
  await db.insert(organizations).values([
    { id: orgId, name: `t1011-${orgId.slice(0,8)}`, slug: `t1011-${orgId.slice(0,8)}` },
    { id: otherOrgId, name: `t1011o-${otherOrgId.slice(0,8)}`, slug: `t1011o-${otherOrgId.slice(0,8)}` },
  ]);
  await db.insert(users).values({
    id: ownerRepId,
    username: `owner-${orgId.slice(0,8)}`,
    password: "x",
    email: `owner-${orgId.slice(0,8)}@broker.example`,
    name: "Owner Rep",
    organizationId: orgId,
    role: "account_manager",
  });
}

async function teardown() {
  await db.delete(customerEmailIdentities).where(eq(customerEmailIdentities.organizationId, orgId));
  await db.delete(customerEmailIdentities).where(eq(customerEmailIdentities.organizationId, otherOrgId));
  await db.delete(companies).where(eq(companies.organizationId, orgId));
  await db.delete(companies).where(eq(companies.organizationId, otherOrgId));
  await db.delete(users).where(eq(users.id, ownerRepId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(organizations).where(eq(organizations.id, otherOrgId));
}

async function run() {
  await setup();
  try {
    // Two companies in the same org so we can prove identity precedence
    // routes to the right one even when domain would have matched.
    const [acme] = await db.insert(companies).values({
      organizationId: orgId, name: "Acme Logistics", ownerRepId,
    }).returning();
    const [beta] = await db.insert(companies).values({
      organizationId: orgId, name: "Beta Freight",
    }).returning();

    // Domain identity → Acme; contact identity → Beta. Same email
    // domain on both, distinct precedence.
    await storage.createCustomerEmailIdentity({
      organizationId: orgId, companyId: acme.id, kind: "domain", value: "acme.example", active: true,
    });
    await storage.createCustomerEmailIdentity({
      organizationId: orgId, companyId: beta.id, kind: "contact", value: "vip@acme.example", active: true,
    });
    await storage.createCustomerEmailIdentity({
      organizationId: orgId, companyId: beta.id, kind: "shared_distribution", value: "ops@acme.example", active: true,
    });

    console.log("── 1. Identity precedence: contact > shared_distribution > domain ──");
    const c = await storage.resolveCustomerIdentityForEmail(orgId, "VIP@acme.example");
    expectEq("contact wins over domain", c?.kind, "contact");
    expectEq("contact resolves to Beta (not Acme by-domain)", c?.companyId, beta.id);

    const sd = await storage.resolveCustomerIdentityForEmail(orgId, "ops@acme.example");
    expectEq("shared_distribution wins over domain", sd?.kind, "shared_distribution");
    expectEq("shared_distribution resolves to Beta", sd?.companyId, beta.id);

    const d = await storage.resolveCustomerIdentityForEmail(orgId, "anyone@acme.example");
    expectEq("domain match falls through last", d?.kind, "domain");
    expectEq("domain resolves to Acme", d?.companyId, acme.id);
    expectEq("domain match exposes Acme.ownerRepId", d?.ownerRepId, ownerRepId);

    const miss = await storage.resolveCustomerIdentityForEmail(orgId, "nobody@unrelated.example");
    expectEq("no match → null", miss, null);

    console.log("── 2. Cross-tenant isolation ──");
    const cross = await storage.resolveCustomerIdentityForEmail(otherOrgId, "anyone@acme.example");
    expectEq("other org sees no identity", cross, null);

    console.log("── 3. Attribution rule names from identity hits ──");
    const baseRow = {
      quote_id: "q1", source_reference: "msg-1", created_at: "2026-04-01T12:00:00Z",
      customer_id: beta.id, customer_name: "Beta Freight",
      rep_id: null, rep_name: null, rep_email: null,
      message_id: "m-1", sender_email: "vip@acme.example", sender_name: "VIP",
      recipient_email: "quotes@broker.example", subject: "RFQ", sent_at: "2026-04-01T11:55:00Z",
      received_at: "2026-04-01T11:56:00Z",
      contact_id: null, contact_name: null, contact_email: null, contact_title: null,
    } as Record<string, string | null>;

    const r1 = buildAttributionResponse(baseRow, { kind: "contact", value: "vip@acme.example", ownerRepId: null });
    expectEq("contact identity → rule customer_contact", r1.rule.name, "customer_contact");

    const r2 = buildAttributionResponse(baseRow, { kind: "shared_distribution", value: "ops@acme.example", ownerRepId: null });
    expectEq("shared_distribution identity → rule shared_distribution", r2.rule.name, "shared_distribution");

    const r3 = buildAttributionResponse(baseRow, { kind: "domain", value: "acme.example", ownerRepId: null });
    expectEq("domain identity → rule customer_domain", r3.rule.name, "customer_domain");

    console.log("── 4. account_owner_fallback when rep matches ownerRepId and no recipient ──");
    const fallbackRow = { ...baseRow, rep_id: ownerRepId, rep_name: "Owner Rep", recipient_email: null };
    const r4 = buildAttributionResponse(fallbackRow, { kind: "domain", value: "acme.example", ownerRepId });
    expectEq("owner-rep + no recipient → account_owner_fallback", r4.rule.name, "account_owner_fallback");

    console.log("── 5. No identity present → legacy account_owner / fallback rules unchanged ──");
    const r5 = buildAttributionResponse(baseRow);
    expectEq("no identity, has message → account_owner", r5.rule.name, "account_owner");
    const r6 = buildAttributionResponse({ ...baseRow, message_id: null });
    expectEq("no identity, no message → fallback", r6.rule.name, "fallback");

  } finally {
    await teardown();
  }

  console.log("──────────────────────────────────────────────────────────────");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════════════════════════════");
  if (failed > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch(err => { console.error("FATAL", err); process.exit(2); });
