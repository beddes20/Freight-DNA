/**
 * Storage-Layer Integration Tests
 *
 * Exercises the storage interface directly against a live PostgreSQL database
 * to verify that CRUD operations work correctly and cross-organization data
 * isolation is enforced at the storage level where applicable.
 *
 * Note: Contact-level org isolation is enforced at the route/auth layer
 * (tested by IDOR guardrail tests). Company operations enforce orgId in
 * every DB call, which is what this file verifies for companies.
 *
 * Run with: npx tsx tests/storage-integration.test.ts
 *
 * Prerequisites: DATABASE_URL must be set and the schema must be migrated.
 */

import { storage, db } from "../server/storage";
import { organizations, users, companies } from "../shared/schema";
import { eq } from "drizzle-orm";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    const msg = detail ? `  ✗ ${description}\n    ${detail}` : `  ✗ ${description}`;
    console.error(msg);
    failures.push(description + (detail ? ` — ${detail}` : ""));
    failed++;
  }
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

const orgIdsToCleanup: string[] = [];

async function seedOrg(suffix: string): Promise<{ id: string; name: string }> {
  const ts = Date.now();
  const [org] = await db
    .insert(organizations)
    .values({ name: `Test Org ${suffix} ${ts}`, slug: `test-org-${suffix.toLowerCase()}-${ts}` })
    .returning();
  orgIdsToCleanup.push(org.id);
  return org;
}

async function seedUser(orgId: string, suffix: string): Promise<{ id: string; organizationId: string; name: string; role: string }> {
  const [user] = await db
    .insert(users)
    .values({
      organizationId: orgId,
      name: `Test User ${suffix}`,
      username: `testuser-${suffix.toLowerCase()}-${Date.now()}@example.com`,
      role: "sales",
      password: "hashed_test_password",
      managerId: null,
    })
    .returning();
  return user;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  for (const orgId of orgIdsToCleanup) {
    // contacts are deleted via cascade when their company is deleted
    await db.delete(companies).where(eq(companies.organizationId, orgId));
    await db.delete(users).where(eq(users.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
}

// ── Test state ────────────────────────────────────────────────────────────────

let orgA: { id: string; name: string };
let orgB: { id: string; name: string };
let userA: { id: string; organizationId: string; name: string; role: string };

async function setup(): Promise<void> {
  orgA = await seedOrg("A");
  orgB = await seedOrg("B");
  userA = await seedUser(orgA.id, "A");
}

// ── Companies CRUD ────────────────────────────────────────────────────────────

async function testCompaniesCrud(): Promise<void> {
  console.log("\n── Companies CRUD ────────────────────────────────────────────────────\n");

  const created = await storage.createCompany({
    organizationId: orgA.id,
    name: "Acme Freight Co",
    assignedTo: userA.id,
  });

  assert("createCompany — returns a record with an id", !!created.id);
  assert("createCompany — name matches", created.name === "Acme Freight Co");
  assert("createCompany — belongs to orgA", created.organizationId === orgA.id);

  // Same-org fetch succeeds
  const fetched = await storage.getCompanyInOrg(created.id, orgA.id);
  assert("getCompanyInOrg — same org returns the record", !!fetched && fetched.id === created.id);

  // Cross-org fetch returns nothing
  const crossOrg = await storage.getCompanyInOrg(created.id, orgB.id);
  assert("getCompanyInOrg — cross-org returns undefined", crossOrg === undefined || crossOrg === null);

  // List scoping
  const allForOrgA = await storage.getCompanies(orgA.id);
  assert("getCompanies — orgA list includes the new company", allForOrgA.some(c => c.id === created.id));

  const allForOrgB = await storage.getCompanies(orgB.id);
  assert("getCompanies — orgB list does NOT include orgA company", !allForOrgB.some(c => c.id === created.id));

  // Update with correct org succeeds
  const updated = await storage.updateCompany(created.id, orgA.id, { name: "Acme Logistics Inc" });
  assert("updateCompany — name updated", updated?.name === "Acme Logistics Inc");

  // Update with wrong org fails (returns null/undefined — no cross-org write)
  const wrongOrgUpdate = await storage.updateCompany(created.id, orgB.id, { name: "Hacked Name" });
  assert("updateCompany — cross-org update returns null/undefined", !wrongOrgUpdate);

  // Verify the name was NOT changed by the cross-org attempt
  const afterBadUpdate = await storage.getCompanyInOrg(created.id, orgA.id);
  assert("updateCompany — cross-org attempt did not mutate the record", afterBadUpdate?.name === "Acme Logistics Inc");

  // Archive / unarchive
  const archived = await storage.archiveCompany(created.id, orgA.id);
  assert("archiveCompany — sets archivedAt", !!archived?.archivedAt);

  const unarchived = await storage.unarchiveCompany(created.id, orgA.id);
  assert("unarchiveCompany — clears archivedAt", !unarchived?.archivedAt);

  // Delete
  const deleted = await storage.deleteCompany(created.id, orgA.id);
  assert("deleteCompany — returns truthy", !!deleted);

  const afterDelete = await storage.getCompanyInOrg(created.id, orgA.id);
  assert("deleteCompany — record is gone after delete", !afterDelete);
}

// ── Contacts CRUD ─────────────────────────────────────────────────────────────

async function testContactsCrud(): Promise<void> {
  console.log("\n── Contacts CRUD ─────────────────────────────────────────────────────\n");

  const company = await storage.createCompany({
    organizationId: orgA.id,
    name: "Contact Test Corp",
    assignedTo: userA.id,
  });

  // Create — contacts are org-scoped only via their company (no direct orgId column)
  const contact = await storage.createContact({
    companyId: company.id,
    name: "Jane Shipper",
    title: "Logistics Manager",
  });

  assert("createContact — returns a record with an id", !!contact.id);
  assert("createContact — name matches", contact.name === "Jane Shipper");
  assert("createContact — linked to the correct company", contact.companyId === company.id);

  // Read by id
  const fetched = await storage.getContact(contact.id);
  assert("getContact — returns the record by id", !!fetched && fetched.id === contact.id);

  // Read by company
  const byCompany = await storage.getContactsByCompany(company.id);
  assert("getContactsByCompany — includes the new contact", byCompany.some(c => c.id === contact.id));

  // Update
  const updatedContact = await storage.updateContact(contact.id, {
    organizationId: orgA.id,
    companyId: company.id,
    name: "Jane Shipper",
    title: "VP Logistics",
  });
  assert("updateContact — title updated", updatedContact?.title === "VP Logistics");

  // Delete
  await storage.deleteContact(contact.id);
  const afterDelete = await storage.getContact(contact.id);
  assert("deleteContact — record is gone", !afterDelete);

  await storage.deleteCompany(company.id, orgA.id);
}

// ── Pinned companies ──────────────────────────────────────────────────────────

async function testPinnedCompanies(): Promise<void> {
  console.log("\n── Pinned Companies ──────────────────────────────────────────────────\n");

  const company = await storage.createCompany({
    organizationId: orgA.id,
    name: "Pin Test Inc",
    assignedTo: userA.id,
  });

  const pinned = await storage.pinCompany(userA.id, company.id);
  assert("pinCompany — returns a record", !!pinned);

  const list = await storage.getPinnedCompanies(userA.id);
  assert("getPinnedCompanies — includes pinned company", list.some(p => p.companyId === company.id));

  await storage.unpinCompany(userA.id, company.id);
  const listAfter = await storage.getPinnedCompanies(userA.id);
  assert("unpinCompany — company removed from list", !listAfter.some(p => p.companyId === company.id));

  await storage.deleteCompany(company.id, orgA.id);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Storage-Layer Integration Tests");
  console.log("══════════════════════════════════════════════════════════════");

  try {
    await setup();
    await testCompaniesCrud();
    await testContactsCrud();
    await testPinnedCompanies();
  } finally {
    await cleanup();
  }

  console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────────────────────────\n`);
  if (failures.length > 0) {
    console.error("Failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
