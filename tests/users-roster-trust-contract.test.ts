/**
 * Users Roster Trust Contract — Subtask B (2026-05-15)
 *
 * Pins the junk-pattern exclusion the /admin/users default roster relies on
 * after the Users Trust Cleanup. A user appears in the default
 * `GET /api/users` response ONLY if their `LOWER(username)` does NOT end
 * with any FIXTURE_MAILBOX_LIKE_PATTERNS suffix (`@example.com` family +
 * RFC 6761 reserved TLDs). Admins can opt back in via the
 * `includeJunkSuspects:true` filter.
 *
 * Cases:
 *   UR-1  example.com user excluded from default `getUsers(orgId, {})`.
 *   UR-2  WQTest-style `wq.test.*@example.com` excluded from default.
 *   UR-3  Real `@valuetruck.com` user included in default.
 *   UR-4  `includeJunkSuspects:true` returns all of UR-1/2/3 (admin path).
 *   UR-5  No-opts `getUsers(orgId)` overload returns all of them — legacy
 *         behavior preserved for internal callers (CQ, financial uploads,
 *         leaderboards, Top Opps, dashboards).
 *   UR-6  `is_fixture=true` row stays excluded under EVERY combo
 *         (Section 1126 invariant — there is no `includeFixture` knob).
 *
 * Run with: npx tsx tests/users-roster-trust-contract.test.ts
 */

import { db, storage } from "../server/storage";
import { organizations, users } from "../shared/schema";
import { eq } from "drizzle-orm";
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
  console.log("\n── Users Roster Trust Contract (Subtask B) ──────────────────────\n");

  // Sandboxed org so we don't touch any real data; we hard-delete every row
  // we create at the end (these are test fixtures, not production data).
  const orgId = randomUUID();
  await db.insert(organizations).values({
    id: orgId,
    name: `users-trust-test-${orgId.slice(0, 8)}`,
    slug: `users-trust-test-${orgId.slice(0, 8)}`,
  });

  // UR-1 fixture: bare example.com user — junk-pattern suffix.
  const exampleId = randomUUID();
  await db.insert(users).values({
    id: exampleId,
    organizationId: orgId,
    username: `pilot-${exampleId.slice(0, 8)}@example.com`,
    email: `pilot-${exampleId.slice(0, 8)}@example.com`,
    name: "Example Pilot",
    role: "account_manager",
  });

  // UR-2 fixture: WQTest-style seed-script identity (the dominant Value
  // Truck leakage shape from the Subtask A audit).
  const wqId = randomUUID();
  await db.insert(users).values({
    id: wqId,
    organizationId: orgId,
    username: `wq.test.${wqId.slice(0, 8)}@example.com`,
    email: `wq.test.${wqId.slice(0, 8)}@example.com`,
    name: `WQTest ${wqId.slice(0, 6)}`,
    role: "account_manager",
  });

  // UR-3 fixture: real-shaped @valuetruck.com employee — must remain
  // visible in the default roster.
  const realId = randomUUID();
  await db.insert(users).values({
    id: realId,
    organizationId: orgId,
    username: `roster-trust-${realId.slice(0, 8)}@valuetruck.com`,
    email: `roster-trust-${realId.slice(0, 8)}@valuetruck.com`,
    name: "Real Employee",
    role: "account_manager",
  });

  // UR-6 fixture: is_fixture=true row — must stay excluded under EVERY
  // flag combo (Section 1126 invariant; no `includeFixture` knob exists).
  const fixtureId = randomUUID();
  await db.insert(users).values({
    id: fixtureId,
    organizationId: orgId,
    username: `fixture-${fixtureId.slice(0, 8)}@valuetruck.com`,
    email: `fixture-${fixtureId.slice(0, 8)}@valuetruck.com`,
    name: "Fixture Row",
    role: "account_manager",
    isFixture: true,
  });

  try {
    // ── UR-1, UR-2, UR-3, UR-6 — default filter (empty opts) ───────────
    const cleaned = await storage.getUsers(orgId, {});
    const cleanedIds = new Set(cleaned.map(u => u.id));
    assert(
      "UR-1 — example.com user EXCLUDED from default getUsers(orgId, {})",
      !cleanedIds.has(exampleId),
      `expected ${exampleId} (pilot-…@example.com) to be filtered out; got ids=[${[...cleanedIds].join(",")}]`,
    );
    assert(
      "UR-2 — WQTest-style wq.test.*@example.com EXCLUDED from default",
      !cleanedIds.has(wqId),
      `expected ${wqId} (wq.test.…@example.com) to be filtered out; got ids=[${[...cleanedIds].join(",")}]`,
    );
    assert(
      "UR-3 — Real @valuetruck.com user INCLUDED in default",
      cleanedIds.has(realId),
      `expected ${realId} (…@valuetruck.com) in default result; got ids=[${[...cleanedIds].join(",")}]`,
    );
    assert(
      "UR-6a — is_fixture=true row EXCLUDED in default (Section 1126 invariant)",
      !cleanedIds.has(fixtureId),
      "is_fixture rows must never appear in any /api/users response",
    );

    // ── UR-4 — admin opt-in returns the junk rows alongside real users ─
    const withJunk = await storage.getUsers(orgId, { includeJunkSuspects: true });
    const withJunkIds = new Set(withJunk.map(u => u.id));
    assert(
      "UR-4a — includeJunkSuspects:true SURFACES the example.com user",
      withJunkIds.has(exampleId),
      `expected ${exampleId} when includeJunkSuspects=true; got ids=[${[...withJunkIds].join(",")}]`,
    );
    assert(
      "UR-4b — includeJunkSuspects:true SURFACES the WQTest-style user",
      withJunkIds.has(wqId),
      `expected ${wqId} when includeJunkSuspects=true; got ids=[${[...withJunkIds].join(",")}]`,
    );
    assert(
      "UR-4c — includeJunkSuspects:true STILL includes the real user",
      withJunkIds.has(realId),
      "the admin opt-in must only widen the view, never narrow it",
    );
    assert(
      "UR-6b — is_fixture=true row STILL EXCLUDED even with includeJunkSuspects:true",
      !withJunkIds.has(fixtureId),
      "there is no `includeFixture` knob by Section 1126 contract — fixture rows stay hidden under every combo",
    );

    // ── UR-5 — no-opts overload preserves legacy "every user" view ─────
    const legacy = await storage.getUsers(orgId);
    const legacyIds = new Set(legacy.map(u => u.id));
    assert(
      "UR-5a — no-opts getUsers(orgId) returns the example.com user (legacy invariant)",
      legacyIds.has(exampleId),
      `internal callers (CQ, leaderboards, financial uploads, dashboards) must NOT silently lose junk rows; got ids=[${[...legacyIds].join(",")}]`,
    );
    assert(
      "UR-5b — no-opts getUsers(orgId) returns the WQTest-style user (legacy invariant)",
      legacyIds.has(wqId),
      "no-opts overload must return every user for historical scoping",
    );
    assert(
      "UR-5c — no-opts getUsers(orgId) returns the real user",
      legacyIds.has(realId),
      "no-opts overload must include the real employee row",
    );
    assert(
      "UR-5d — no-opts getUsers(orgId) STILL returns the is_fixture=true row (legacy invariant)",
      legacyIds.has(fixtureId),
      "the no-opts overload preserves the legacy 'every user' view including fixtures — only the filter overload applies the Section 1126 + Subtask B exclusions",
    );
  } finally {
    // Best-effort fixture cleanup. Hard `db.delete(users)` is gotcha-
    // forbidden in production code (contacts soft-delete contract /
    // Section 1126.3 lifecycle write paths) but allow-listed in tests.
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
