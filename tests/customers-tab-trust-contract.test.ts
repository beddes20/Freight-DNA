/**
 * Customers Tab Trust Contract — Subtask B (2026-05-15)
 *
 * Pins the Bucket D thin-stub exclusion the Customers tab relies on after
 * the trust cleanup. Companies appear in /customers ONLY if they show at
 * least one enrichment signal (owner / assigned / sales / industry / notes
 * / active contact / freight history) — manually-created or freight-active
 * accounts. Bucket D rows (no signal at all) are hidden by default.
 *
 * Cases:
 *   1. Bucket D-style thin stub is excluded when customersOnly=true.
 *   2. Bucket B-style enriched account is included when customersOnly=true.
 *   3. customersOnly=false (or absent on internal callers) returns BOTH
 *      buckets — preserves admin/audit and CQ/auth/internal-call paths.
 *   4. The is_email_derived default-hide contract (Section 1095) is still
 *      honored regardless of customersOnly.
 *
 * Run with: npx tsx tests/customers-tab-trust-contract.test.ts
 */

import { db, storage } from "../server/storage";
import {
  organizations,
  users,
  companies,
  contacts,
} from "../shared/schema";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";

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

async function main() {
  console.log("\n── Customers Tab Trust Contract (Subtask B) ──────────────────────\n");

  // Sandboxed org so we don't touch any real data; we hard-delete every row
  // we create at the end (these are test fixtures, not production data).
  const orgId = randomUUID();
  const adminUserId = randomUUID();
  await db.insert(organizations).values({
    id: orgId,
    name: `customers-trust-test-${orgId.slice(0, 8)}`,
    slug: `customers-trust-test-${orgId.slice(0, 8)}`,
  });
  await db.insert(users).values({
    id: adminUserId,
    organizationId: orgId,
    username: `trust-admin-${orgId.slice(0, 8)}`,
    email: `trust-admin-${orgId.slice(0, 8)}@example.invalid`,
    name: "Trust Test Admin",
    role: "admin",
    isFixture: true,
  });

  // Bucket D thin stub — no enrichment signal at all.
  const thinId = randomUUID();
  await db.insert(companies).values({
    id: thinId,
    organizationId: orgId,
    name: `Thin Stub ${thinId.slice(0, 8)}`,
    isEmailDerived: false,
  });

  // Bucket B enriched stub — non-null `notes` is enough on its own.
  const enrichedId = randomUUID();
  await db.insert(companies).values({
    id: enrichedId,
    organizationId: orgId,
    name: `Enriched ${enrichedId.slice(0, 8)}`,
    notes: "manually created customer",
    isEmailDerived: false,
  });

  // Bucket D shape but with one active contact — should also be VISIBLE
  // because the EXISTS-contacts branch fires (enrichment signal present).
  const thinWithContactId = randomUUID();
  const contactId = randomUUID();
  await db.insert(companies).values({
    id: thinWithContactId,
    organizationId: orgId,
    name: `Thin+Contact ${thinWithContactId.slice(0, 8)}`,
    isEmailDerived: false,
  });
  await db.insert(contacts).values({
    id: contactId,
    organizationId: orgId,
    companyId: thinWithContactId,
    name: "Active Contact",
    email: `active-${contactId.slice(0, 8)}@example.invalid`,
  });

  // Email-derived stub — even with enrichment, must STAY hidden by default
  // (Section 1095 contract — orthogonal to customersOnly).
  const emailDerivedId = randomUUID();
  await db.insert(companies).values({
    id: emailDerivedId,
    organizationId: orgId,
    name: `Email Derived ${emailDerivedId.slice(0, 8)}`,
    notes: "auto-created from inbound email",
    isEmailDerived: true,
  });

  try {
    // ── Case 1 + 2: customersOnly=true hides Bucket D, keeps Bucket B ────
    const cleaned = await storage.getCompanies(orgId, { customersOnly: true });
    const cleanedIds = new Set(cleaned.map(c => c.id));
    assert(
      "Case 1 — Bucket D thin stub is EXCLUDED when customersOnly=true",
      !cleanedIds.has(thinId),
      `expected ${thinId} to be filtered out, got ids=[${[...cleanedIds].join(",")}]`,
    );
    assert(
      "Case 2 — Bucket B enriched account is INCLUDED when customersOnly=true",
      cleanedIds.has(enrichedId),
      `expected ${enrichedId} in result, got ids=[${[...cleanedIds].join(",")}]`,
    );
    assert(
      "Case 2b — Bucket D + active contact (enrichment signal) is INCLUDED",
      cleanedIds.has(thinWithContactId),
      `expected ${thinWithContactId} in result (EXISTS-contacts branch must fire)`,
    );

    // ── Case 3: customersOnly=false returns BOTH buckets (admin/audit) ───
    const full = await storage.getCompanies(orgId, { customersOnly: false });
    const fullIds = new Set(full.map(c => c.id));
    assert(
      "Case 3 — customersOnly=false returns BOTH Bucket B and Bucket D (admin/audit + internal callers)",
      fullIds.has(thinId) && fullIds.has(enrichedId) && fullIds.has(thinWithContactId),
      `expected all three in result, got ids=[${[...fullIds].join(",")}]`,
    );

    // ── Case 3b: no opts at all = legacy behavior (must include thin stubs) ─
    const legacy = await storage.getCompanies(orgId);
    const legacyIds = new Set(legacy.map(c => c.id));
    assert(
      "Case 3b — no-opts call (auth, CQ, internal) includes Bucket D rows (legacy behavior)",
      legacyIds.has(thinId),
      `internal callers must NOT silently get the cleaned filter; got ids=[${[...legacyIds].join(",")}]`,
    );

    // ── Case 4: includeEmailDerived contract (Section 1095) preserved ────
    assert(
      "Case 4a — email-derived row HIDDEN by default even when customersOnly=false",
      !fullIds.has(emailDerivedId),
      "is_email_derived=true must stay hidden unless includeEmailDerived=true",
    );
    const withEmailDerived = await storage.getCompanies(orgId, {
      customersOnly: true,
      includeEmailDerived: true,
    });
    const withIds = new Set(withEmailDerived.map(c => c.id));
    assert(
      "Case 4b — includeEmailDerived=true surfaces the email-derived row alongside customersOnly filter",
      withIds.has(emailDerivedId),
      `expected ${emailDerivedId} in result when includeEmailDerived=true`,
    );
    // Customers-only+includeEmailDerived must STILL exclude the bare thin
    // stub — the two filters compose, they don't override each other.
    assert(
      "Case 4c — customersOnly+includeEmailDerived still excludes the bare thin stub",
      !withIds.has(thinId),
      `customersOnly must still exclude ${thinId} even when includeEmailDerived=true`,
    );
  } finally {
    // Best-effort fixture cleanup. Contacts has no organizationId column —
    // it joins to companies via companyId — so delete by the test fixture
    // company ids we just created. Hard `db.delete(contacts)` is gotcha-
    // forbidden in production code but allow-listed in tests.
    const fixtureCompanyIds = [thinId, enrichedId, thinWithContactId, emailDerivedId];
    await db.delete(contacts).where(inArray(contacts.companyId, fixtureCompanyIds));
    await db.delete(companies).where(eq(companies.organizationId, orgId));
    await db.delete(users).where(eq(users.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }

  console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("\nFailures:");
    failures.forEach(f => console.error(`  - ${f}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
