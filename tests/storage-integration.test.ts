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

// ── Manager assignment & cycle detection (Task #815) ─────────────────────────
//
// Regression coverage for the 503 admins hit when changing a user's "Reports
// To". The PATCH /api/users/:id flow now goes through
// storage.wouldCreateManagerCycle before writing managerId, so this exercises
// (a) plain reassignment + null reset still works, and (b) the cycle guard
// rejects the assignments that previously crashed downstream chain walks.

async function testManagerAssignment(): Promise<void> {
  console.log("\n── Manager Assignment & Cycle Detection ──────────────────────────────\n");

  const manager1 = await seedUser(orgA.id, "Mgr1");
  const manager2 = await seedUser(orgA.id, "Mgr2");
  const rep = await seedUser(orgA.id, "Rep");

  // Successfully assign rep → manager1
  const assigned = await storage.updateUser(rep.id, orgA.id, { managerId: manager1.id });
  assert("updateUser — assigns managerId successfully", assigned?.managerId === manager1.id);

  // Switch to a different manager
  const switched = await storage.updateUser(rep.id, orgA.id, { managerId: manager2.id });
  assert("updateUser — switches managerId to a different manager", switched?.managerId === manager2.id);

  // Clear back to null
  const cleared = await storage.updateUser(rep.id, orgA.id, { managerId: null });
  assert("updateUser — clears managerId back to null", cleared?.managerId === null);

  // Cycle detection — self-reference
  const selfCycle = await storage.wouldCreateManagerCycle(rep.id, rep.id, orgA.id);
  assert("wouldCreateManagerCycle — flags self-reference as a cycle", selfCycle === true);

  // Cycle detection — descendant cycle. Set up rep → manager1 (rep reports to
  // manager1). Then assigning manager1.managerId = rep would close a cycle.
  await storage.updateUser(rep.id, orgA.id, { managerId: manager1.id });
  const descendantCycle = await storage.wouldCreateManagerCycle(manager1.id, rep.id, orgA.id);
  assert(
    "wouldCreateManagerCycle — flags assigning a manager to one of its own descendants as a cycle",
    descendantCycle === true,
  );

  // Non-cycle: assigning manager1 → manager2 is fine
  const notACycle = await storage.wouldCreateManagerCycle(manager1.id, manager2.id, orgA.id);
  assert("wouldCreateManagerCycle — returns false for a normal assignment", notACycle === false);

  // Cycle detection terminates even if the data already contains a cycle.
  // Force one in raw SQL (storage.updateUser would otherwise refuse via the
  // route layer, but the storage method itself doesn't gate writes).
  await db.update(users).set({ managerId: manager2.id }).where(eq(users.id, manager1.id));
  await db.update(users).set({ managerId: manager1.id }).where(eq(users.id, manager2.id));
  const start = Date.now();
  const preExistingCycle = await storage.wouldCreateManagerCycle(rep.id, manager1.id, orgA.id);
  const elapsedMs = Date.now() - start;
  assert(
    "wouldCreateManagerCycle — terminates quickly even with a pre-existing cycle in data",
    elapsedMs < 1000,
    `elapsed=${elapsedMs}ms`,
  );
  assert(
    "wouldCreateManagerCycle — returns a boolean for a pre-existing cycle (no infinite loop)",
    typeof preExistingCycle === "boolean",
  );

  // Reset so cleanup() can proceed without FK headaches.
  await db.update(users).set({ managerId: null }).where(eq(users.id, manager1.id));
  await db.update(users).set({ managerId: null }).where(eq(users.id, manager2.id));
  await db.update(users).set({ managerId: null }).where(eq(users.id, rep.id));
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
    await testManagerAssignment();
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
