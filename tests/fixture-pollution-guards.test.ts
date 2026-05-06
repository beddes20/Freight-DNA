/**
 * Regression tests for the three-layer fixture-pollution guardrail
 * (Webhook unhealthy permanent fix).
 *
 * Layers verified:
 *   1. Boot-time SCAN  — runMigrations() exposes counts via
 *      getFixtureContaminationScan(). Verified by writing the cache
 *      directly with setFixtureContaminationScan() and reading back.
 *   2. Boundary GUARD  — assertNotFixtureEmail throws for fixture domains
 *      and is wired into storage.createUser/createCompany/createContact +
 *      bulk variants. Storage CRUD must reject inserts that contain
 *      fixture addresses, while still accepting real addresses.
 *   3. ADMIN ALERTING  — notifyOnInboxUnhealthy fires once and then
 *      throttles within the 24h window for the same org.
 *
 * Run with: npx tsx tests/fixture-pollution-guards.test.ts
 */
import { storage, db } from "../server/storage";
import {
  assertNotFixtureEmail,
  isFixtureMailboxAddress,
  FixtureMailboxError,
  setFixtureContaminationScan,
  getFixtureContaminationScan,
} from "../server/lib/fixtureMailboxes";
import {
  notifyOnInboxUnhealthy,
  _internals as alerterInternals,
} from "../server/services/conversationsInboxAlerter";
import { organizations, users, companies, contacts, notifications } from "../shared/schema";
import { eq, and } from "drizzle-orm";

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

const cleanupOrgIds: string[] = [];

async function seedOrg(): Promise<{ id: string; name: string }> {
  const ts = Date.now() + Math.floor(Math.random() * 1_000_000);
  const [org] = await db
    .insert(organizations)
    .values({ name: `Fixture Guard Org ${ts}`, slug: `fix-guard-${ts}` })
    .returning();
  cleanupOrgIds.push(org.id);
  return org;
}

async function cleanup() {
  // contacts cascade-delete from companies; companies/users delete by org;
  // notifications keyed by relatedId so they're cleaned in one shot.
  try {
    await db.delete(notifications).where(eq(notifications.relatedId, alerterInternals.RELATED_ID));
  } catch {/* best-effort */}
  for (const orgId of cleanupOrgIds) {
    try { await db.delete(companies).where(eq(companies.organizationId, orgId)); } catch {/* best-effort */}
    try { await db.delete(users).where(eq(users.organizationId, orgId)); } catch {/* best-effort */}
    try { await db.delete(organizations).where(eq(organizations.id, orgId)); } catch {/* best-effort */}
  }
}

async function runLayer1_ScanCache() {
  console.log("\n── Layer 1: boot-time scan cache ─────────────────────────");
  const before = getFixtureContaminationScan();
  assert("scan cache exposed (may be null pre-migration)", before === null || typeof before === "object");
  setFixtureContaminationScan({
    monitoredMailboxes: 0,
    users: 2,
    companies: 1,
    contacts: 3,
    scannedAt: new Date().toISOString(),
    samples: [{ table: "users", column: "username", email: "qa@example.com" }],
  });
  const after = getFixtureContaminationScan();
  assert("setFixtureContaminationScan persists in module-level cache", after !== null && after.users === 2 && after.companies === 1 && after.contacts === 3);
  assert("scan cache exposes samples", (after?.samples.length ?? 0) === 1);
  setFixtureContaminationScan(before); // restore
}

async function runLayer2_BoundaryGuards() {
  console.log("\n── Layer 2: storage boundary guards ───────────────────────");

  // Pure helper coverage — only use addresses that match
  // FIXTURE_MAILBOX_DOMAINS (RFC 6761 reserved + example.{com,org,net}).
  const fixtures = [
    "qa@example.com",
    "test@example.org",
    "demo@example.net",
    "alice@acme.example",
    "ops@my.test",
    "x@nope.invalid",
    "y@host.localhost",
    "z@test.local",
  ];
  for (const f of fixtures) {
    assert(`isFixtureMailboxAddress flags ${f}`, isFixtureMailboxAddress(f));
    let threw = false;
    try { assertNotFixtureEmail(f, "users.username"); } catch (e) {
      threw = e instanceof FixtureMailboxError;
    }
    assert(`assertNotFixtureEmail throws FixtureMailboxError for ${f}`, threw);
  }
  for (const real of ["sales@valuetruck.com", "buyer@acme-foods.com", "dispatch@cargopros.io"]) {
    assert(`isFixtureMailboxAddress passes real address ${real}`, !isFixtureMailboxAddress(real));
    let threw = false;
    try { assertNotFixtureEmail(real, "users.username"); } catch { threw = true; }
    assert(`assertNotFixtureEmail accepts real address ${real}`, !threw);
  }

  const org = await seedOrg();
  const ts = Date.now();

  // storage.createUser — fixture username rejected
  let userThrew = false;
  try {
    await storage.createUser({
      username: `qa-${ts}@example.com`,
      password: "x",
      name: "QA",
      role: "sales",
      organizationId: org.id,
    } as any);
  } catch (e) {
    userThrew = e instanceof FixtureMailboxError;
  }
  assert("storage.createUser rejects fixture username", userThrew);

  // storage.createUser — real username accepted
  const realUser = await storage.createUser({
    username: `real-${ts}@valuetruck.com`,
    password: "x",
    name: "Real",
    role: "sales",
    organizationId: org.id,
  } as any);
  assert("storage.createUser accepts non-fixture username", !!realUser?.id);

  // storage.createCompany — fixture dlEmail rejected
  let companyThrew = false;
  try {
    await storage.createCompany({
      name: "Bad Co",
      organizationId: org.id,
      dlEmail: `dl-${ts}@example.com`,
    } as any);
  } catch (e) {
    companyThrew = e instanceof FixtureMailboxError;
  }
  assert("storage.createCompany rejects fixture dlEmail", companyThrew);

  const realCompany = await storage.createCompany({
    name: "Good Co",
    organizationId: org.id,
    dlEmail: `dl-${ts}@goodco.com`,
  } as any);
  assert("storage.createCompany accepts non-fixture dlEmail", !!realCompany?.id);

  // storage.createContact — fixture email rejected
  // contacts table has no organizationId column — scoping is via companyId.
  let contactThrew = false;
  try {
    await storage.createContact({
      name: "Bad Contact",
      companyId: realCompany.id,
      email: `c-${ts}@example.com`,
    } as any);
  } catch (e) {
    contactThrew = e instanceof FixtureMailboxError;
  }
  assert("storage.createContact rejects fixture email", contactThrew);

  const realContact = await storage.createContact({
    name: "Good Contact",
    companyId: realCompany.id,
    email: `c-${ts}@goodco.com`,
  } as any);
  assert("storage.createContact accepts non-fixture email", !!realContact?.id);

  // storage.bulkCreateContacts — quarantines fixture rows, keeps real ones.
  // Architect-recommended behavior: a 5,000-row CSV import containing one
  // accidental @example.com address must NOT abort the whole batch.
  const bulkResult = await storage.bulkCreateContacts([
    { name: `Mixed1-${ts}`, companyId: realCompany.id, email: `b1-${ts}@goodco.com` } as any,
    { name: `Mixed2-${ts}`, companyId: realCompany.id, email: `b2-${ts}@example.com` } as any,
  ]);
  assert(
    "storage.bulkCreateContacts quarantines fixture rows, persists real ones",
    bulkResult.length === 1 && bulkResult[0].email === `b1-${ts}@goodco.com`,
    `expected 1 row, got ${bulkResult.length}`,
  );

  // storage.bulkCreateCompanies — same quarantine pattern
  const bulkCompanies = await storage.bulkCreateCompanies([
    { name: `BulkGood-${ts}`, organizationId: org.id, dlEmail: `bc1-${ts}@goodco.com` } as any,
    { name: `BulkBad-${ts}`, organizationId: org.id, dlEmail: `bc2-${ts}@example.com` } as any,
  ]);
  assert(
    "storage.bulkCreateCompanies quarantines fixture rows, persists real ones",
    bulkCompanies.length === 1 && bulkCompanies[0].name === `BulkGood-${ts}`,
    `expected 1 row, got ${bulkCompanies.length}`,
  );

  return { orgId: org.id, realUser };
}

async function runLayer3_AlerterThrottle(orgId: string) {
  console.log("\n── Layer 3: conversations-inbox alerter throttle ──────────");

  // Need an admin user in the org for fanout to occur.
  const ts = Date.now();
  await db.insert(users).values({
    username: `admin-${ts}@valuetruck.com`,
    password: "x",
    name: "Admin",
    role: "admin",
    organizationId: orgId,
  } as any);

  // healthy → no fire
  const fireOnHealthy = await notifyOnInboxUnhealthy({
    organizationId: orgId,
    status: "healthy" as const,
    webhookFailureCount: 0,
    pendingRecoveryThreadCount: 0,
    totalMailboxes: 3,
  });
  assert("alerter no-ops when status === healthy", fireOnHealthy === false);

  const fireOnRecovering = await notifyOnInboxUnhealthy({
    organizationId: orgId,
    status: "recovering" as const,
    webhookFailureCount: 0,
    pendingRecoveryThreadCount: 1,
    totalMailboxes: 3,
  });
  assert("alerter no-ops when status === recovering", fireOnRecovering === false);

  // first unhealthy → fires
  const firstFire = await notifyOnInboxUnhealthy({
    organizationId: orgId,
    status: "unhealthy" as const,
    webhookFailureCount: 2,
    pendingRecoveryThreadCount: 1,
    totalMailboxes: 3,
    detail: "Subscription expired 2026-04-26",
  });
  assert("alerter fires on first unhealthy snapshot", firstFire === true);

  const adminNotifs = await db
    .select()
    .from(notifications)
    .where(and(
      eq(notifications.type, alerterInternals.NOTIFICATION_TYPE),
      eq(notifications.relatedId, alerterInternals.RELATED_ID),
    ));
  assert("notification row written for admin in org", adminNotifs.length >= 1);
  assert("notification links to /admin/integrations-health", adminNotifs[0].link === "/admin/integrations-health");

  // second unhealthy within 24h → throttled
  const secondFire = await notifyOnInboxUnhealthy({
    organizationId: orgId,
    status: "unhealthy" as const,
    webhookFailureCount: 2,
    pendingRecoveryThreadCount: 1,
    totalMailboxes: 3,
  });
  assert("alerter throttles second unhealthy within 24h", secondFire === false);

  const afterCount = (await db
    .select()
    .from(notifications)
    .where(and(
      eq(notifications.type, alerterInternals.NOTIFICATION_TYPE),
      eq(notifications.relatedId, alerterInternals.RELATED_ID),
    ))).length;
  assert("no extra notification row after throttled call", afterCount === adminNotifs.length);
}

(async () => {
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Fixture-Pollution Guardrail — Regression Tests");
  console.log("══════════════════════════════════════════════════════════════");
  try {
    await runLayer1_ScanCache();
    const { orgId } = await runLayer2_BoundaryGuards();
    await runLayer3_AlerterThrottle(orgId);
  } catch (err) {
    console.error("FATAL:", err);
    failed++;
    failures.push(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await cleanup().catch(err => console.warn("Cleanup error:", err));
  }
  console.log("──────────────────────────────────────────────────────────────");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════════════════════════════");
  if (failed > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
})();
