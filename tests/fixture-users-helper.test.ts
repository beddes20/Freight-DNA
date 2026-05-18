/**
 * Task #1179 (FUC-P1-S1) — Unit coverage for `isFixtureUser`.
 *
 * Verifies the composition contract documented in
 * `docs/fixture-user-cleanup-contract.md`.
 *
 * Run: npx tsx tests/fixture-users-helper.test.ts
 */

import { isFixtureUser } from "../server/lib/fixtureUsers";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
    failed++;
  }
}

console.log("\n── isFixtureUser — positives ────────────────────────────────────\n");

assert("WQTest 73cb0c (wq.test.*@example.com)", isFixtureUser({
  username: "wq.test.73cb0c@example.com",
  name: "WQTest 73cb0c",
}));

assert("coe.test.y@example.com", isFixtureUser({
  username: "coe.test.fec7abf8@example.com",
  name: "COETest fec7ab",
}));

assert("bare @example.com pilot", isFixtureUser({
  username: "pilot@example.com",
  name: "Example Pilot",
}));

assert("@.test reserved TLD", isFixtureUser({
  username: "real.person@acme.test",
  name: "Real Person",
}));

assert("is_fixture=true wins", isFixtureUser({
  username: "real@valuetruck.com",
  name: "Real Person",
  isFixture: true,
}));

assert("is_demo=true wins", isFixtureUser({
  username: "real@valuetruck.com",
  name: "Real Person",
  isDemo: true,
}));

assert("is_quarantined=true wins", isFixtureUser({
  username: "real@valuetruck.com",
  name: "Real Person",
  isQuarantined: true,
}));

assert("is_service_account=true wins", isFixtureUser({
  username: "ops@valuetruck.com",
  name: "Ops Inbox",
  isServiceAccount: true,
}));

assert("is_active=false wins", isFixtureUser({
  username: "former.rep@valuetruck.com",
  name: "Former Rep",
  isActive: false,
}));

assert("deletedAt set (Date) wins", isFixtureUser({
  username: "former.rep@valuetruck.com",
  name: "Former Rep",
  deletedAt: new Date(),
}));

assert("deletedAt set (string) wins", isFixtureUser({
  username: "former.rep@valuetruck.com",
  name: "Former Rep",
  deletedAt: "2026-01-01T00:00:00Z",
}));

assert("seed wq.test name pattern", isFixtureUser({
  username: "real@valuetruck.com",
  name: "wq.test.runner",
}));

console.log("\n── isFixtureUser — negatives ────────────────────────────────────\n");

assert("real @valuetruck.com AM is NOT a fixture", !isFixtureUser({
  username: "adan.castaneda@valuetruck.com",
  name: "Adan Castaneda",
  isActive: true,
  isFixture: false,
  isDemo: false,
  isQuarantined: false,
  isServiceAccount: false,
  deletedAt: null,
}));

assert("real @coyote.com AM is NOT a fixture", !isFixtureUser({
  username: "rep@coyote.com",
  name: "Rep Name",
  isActive: true,
}));

assert("real @valuetruck.com AM with no lifecycle flags set", !isFixtureUser({
  username: "ben.beddes@valuetruck.com",
  name: "Ben Beddes",
}));

assert("null input returns false", !isFixtureUser(null));
assert("undefined input returns false", !isFixtureUser(undefined));
assert("empty object returns false", !isFixtureUser({}));

console.log(`\n── Result: ${passed} passed, ${failed} failed ──────────────────────\n`);
if (failed > 0) {
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
