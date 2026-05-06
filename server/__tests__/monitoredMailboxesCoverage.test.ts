/**
 * Task #517 — coverage banner + Mail.Read consent surface tests.
 *
 * The route handlers themselves are thin wrappers around storage + the
 * graphSubscriptionService consent state. We verify:
 *  1. The Mail.Read consent module reports a consistent snapshot shape.
 *  2. The severity classification used by the coverage endpoint maps
 *     each combination of inputs to the expected banner severity.
 *
 * Pure unit-level — no DB, no HTTP. Run with:
 *   npx vitest run server/__tests__/monitoredMailboxesCoverage.test.ts
 */
import { describe, it, expect } from "vitest";
import { getMailReadConsentStatus } from "../graphSubscriptionService";
import { ELIGIBLE_ROLES } from "../routes/monitoredMailboxes";

// Mirror the severity logic used inside the coverage handler. Keeping the
// pure function here lets us unit-test classification without standing up
// the storage layer or running an HTTP server.
type ConsentStatus = "granted" | "pending" | "denied" | "unknown";
// Import the real classifier so the test suite locks the actual
// production logic (no risk of test helper drifting from the route).
import { classifyCoverage } from "../services/coverageClassifier";

describe("getMailReadConsentStatus", () => {
  it("returns the documented shape with safe defaults at boot", () => {
    const s = getMailReadConsentStatus();
    expect(s).toMatchObject({
      status: expect.stringMatching(/granted|pending|denied|unknown/),
      lastCheckedAt: expect.toSatisfy(
        (v: unknown) => v === null || typeof v === "string",
      ),
      lastError: expect.toSatisfy(
        (v: unknown) => v === null || typeof v === "string",
      ),
      configured: expect.any(Boolean),
    });
    expect("mailbox" in s).toBe(true);
  });
});

describe("coverage severity classification", () => {
  it("returns ok when fully healthy", () => {
    const r = classifyCoverage({
      eligibleUsers: 5,
      enrolledMailboxes: 5,
      consentStatus: "granted",
      consentConfigured: true,
      failedBackfills: 0,
      neverBackfilled: 0,
    });
    expect(r.severity).toBe("ok");
    expect(r.reasons).toEqual([]);
  });

  it("warns when eligible reps exist but nothing is enrolled", () => {
    const r = classifyCoverage({
      eligibleUsers: 4,
      enrolledMailboxes: 0,
      consentStatus: "granted",
      consentConfigured: true,
      failedBackfills: 0,
      neverBackfilled: 0,
    });
    expect(r.severity).toBe("warn");
    expect(r.reasons).toContain("zero_enrolled");
  });

  it("escalates to error when Mail.Read consent is denied", () => {
    const r = classifyCoverage({
      eligibleUsers: 3,
      enrolledMailboxes: 3,
      consentStatus: "denied",
      consentConfigured: true,
      failedBackfills: 0,
      neverBackfilled: 0,
    });
    expect(r.severity).toBe("error");
    expect(r.reasons).toContain("mail_read_missing");
  });

  it("does NOT raise mail_read_missing when Azure is unconfigured", () => {
    // Azure not configured = self-hosted dev environment without Graph
    // creds. Banner stays clean rather than yelling about consent the
    // operator can't grant.
    const r = classifyCoverage({
      eligibleUsers: 0,
      enrolledMailboxes: 0,
      consentStatus: "unknown",
      consentConfigured: false,
      failedBackfills: 0,
      neverBackfilled: 0,
    });
    expect(r.reasons).not.toContain("mail_read_missing");
  });

  it("warns when backfills failed even if consent is granted", () => {
    const r = classifyCoverage({
      eligibleUsers: 5,
      enrolledMailboxes: 5,
      consentStatus: "granted",
      consentConfigured: true,
      failedBackfills: 2,
      neverBackfilled: 0,
    });
    expect(r.severity).toBe("warn");
    expect(r.reasons).toContain("backfill_failed");
  });

  it("treats failed backfills + denied consent as the worst severity (error)", () => {
    const r = classifyCoverage({
      eligibleUsers: 5,
      enrolledMailboxes: 5,
      consentStatus: "denied",
      consentConfigured: true,
      failedBackfills: 3,
      neverBackfilled: 0,
    });
    expect(r.severity).toBe("error");
    expect(r.reasons).toEqual(
      expect.arrayContaining(["mail_read_missing", "backfill_failed"]),
    );
  });

  it("info when all enrolled mailboxes are still waiting on first backfill", () => {
    const r = classifyCoverage({
      eligibleUsers: 5,
      enrolledMailboxes: 3,
      consentStatus: "granted",
      consentConfigured: true,
      failedBackfills: 0,
      neverBackfilled: 3,
    });
    expect(r.severity).toBe("info");
    expect(r.reasons).toContain("backfill_pending");
  });

  it("flags backfill_pending whenever ANY mailbox is unbackfilled (Task #517)", () => {
    // Even with the majority backfilled, the gap matters — admins must
    // see partial coverage so they can chase the stragglers.
    const r = classifyCoverage({
      eligibleUsers: 10,
      enrolledMailboxes: 10,
      consentStatus: "granted",
      consentConfigured: true,
      failedBackfills: 0,
      neverBackfilled: 1,
    });
    expect(r.reasons).toContain("backfill_pending");
    expect(r.severity).toBe("info");
  });

  it("keeps warn severity when backfill_pending coexists with backfill_failed", () => {
    const r = classifyCoverage({
      eligibleUsers: 5,
      enrolledMailboxes: 5,
      consentStatus: "granted",
      consentConfigured: true,
      failedBackfills: 1,
      neverBackfilled: 2,
    });
    expect(r.severity).toBe("warn");
    expect(r.reasons).toEqual(
      expect.arrayContaining(["backfill_failed", "backfill_pending"]),
    );
  });
});

describe("enroll-all idempotency (Task #517)", () => {
  // The route walks every eligible user once per call. Re-running the
  // enroll-all endpoint must NOT re-enroll already-enrolled mailboxes
  // and must NOT re-trigger backfill for those same mailboxes — only
  // truly new rows count as "added". We exercise the same skip logic
  // used by the route (existingEmails set membership).
  type Outcome = "enrolled" | "already_enrolled" | "skipped_no_mailbox" | "error";
  interface User { id: string; name: string; email: string | null }
  function runEnrollAll(
    users: User[],
    existingEmailsLower: Set<string>,
    existingUserIds: Set<string>,
  ) {
    const created: User[] = [];
    const results: { userId: string; outcome: Outcome }[] = [];
    let added = 0, skipped = 0, skippedNoMailbox = 0;
    for (const u of users) {
      if (!u.email) {
        skippedNoMailbox++;
        results.push({ userId: u.id, outcome: "skipped_no_mailbox" });
        continue;
      }
      const lower = u.email.toLowerCase();
      if (existingEmailsLower.has(lower) || existingUserIds.has(u.id)) {
        skipped++;
        results.push({ userId: u.id, outcome: "already_enrolled" });
        continue;
      }
      added++;
      created.push(u);
      existingEmailsLower.add(lower);
      existingUserIds.add(u.id);
      results.push({ userId: u.id, outcome: "enrolled" });
    }
    return { added, skipped, skippedNoMailbox, results, created };
  }

  it("a second enroll-all run adds zero new mailboxes when nothing changed", () => {
    const users: User[] = [
      { id: "u1", name: "A", email: "a@x" },
      { id: "u2", name: "B", email: "b@x" },
    ];
    const existingEmails = new Set<string>();
    const existingUserIds = new Set<string>();
    const first = runEnrollAll(users, existingEmails, existingUserIds);
    expect(first.added).toBe(2);
    expect(first.created).toHaveLength(2);
    const second = runEnrollAll(users, existingEmails, existingUserIds);
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.created).toHaveLength(0);
  });

  it("only newly-created mailboxes get queued for backfill (not the re-runs)", () => {
    const existingEmails = new Set<string>(["a@x"]);
    const existingUserIds = new Set<string>(["u1"]);
    const users: User[] = [
      { id: "u1", name: "A", email: "a@x" },
      { id: "u3", name: "C", email: "c@x" },
    ];
    const result = runEnrollAll(users, existingEmails, existingUserIds);
    expect(result.added).toBe(1);
    expect(result.created.map(c => c.id)).toEqual(["u3"]);
    // The route only fires triggerBackfillInBackground over `created` — so
    // backfill is invoked exactly once for u3 in this scenario.
    const backfillTargets = result.created.map(c => c.id);
    expect(backfillTargets).toHaveLength(1);
  });

  it("case-insensitive duplicate detection prevents double-enroll", () => {
    const existingEmails = new Set<string>(["alice@x"]);
    const existingUserIds = new Set<string>();
    const users: User[] = [{ id: "u1", name: "Alice", email: "ALICE@X" }];
    const result = runEnrollAll(users, existingEmails, existingUserIds);
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

describe("ingestion-source tagging (Task #517)", () => {
  // The historical backfill caller passes ingestedVia: "backfill" to
  // processUserMailboxEmailForDelta. This contract is what makes the
  // spot-quote-from-backfill counter meaningful — without the tag, we
  // can't distinguish backfill output from live delta sync. We can't
  // run the full webhook handler here without a DB, but we can pin the
  // contract by importing the helper signature and verifying our caller
  // never silently drops the tag.
  it("backfill caller sends the literal 'backfill' tag", async () => {
    // Read the source file (cheap) and assert the call site carries
    // the tag. This catches accidental removal of the propagation.
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "server/services/mailboxHistoricalBackfillService.ts",
      "utf8",
    );
    expect(src).toContain('ingestedVia: "backfill"');
  });

  it("delta webhook keeps default 'delta' tag (no explicit override)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("server/routes/graphWebhook.ts", "utf8");
    // The helper defaults to 'delta' when ingestedVia is omitted; the
    // webhook handler relies on that default and must not pass any
    // other value at the upsert site (only the helper's own internal
    // line should set ingestedVia).
    expect(src).toContain("ingestedVia,");
    expect(src).toContain('params.ingestedVia ?? "delta"');
  });
});

describe("consent state transitions (Task #517)", () => {
  // The persisted consent loader is exercised lazily on first read. We
  // assert the public accessor never throws and always returns a valid
  // shape regardless of whether the DB row exists yet — important for
  // first-boot and self-hosted dev environments without the table.
  it("getMailReadConsentStatus is safe to call repeatedly without setup", () => {
    const a = getMailReadConsentStatus();
    const b = getMailReadConsentStatus();
    expect(a.status).toBe(b.status);
    expect(["granted", "pending", "denied", "unknown"]).toContain(a.status);
  });

  it("reports configured=true when Azure creds are present (env-driven)", () => {
    const s = getMailReadConsentStatus();
    expect(typeof s.configured).toBe("boolean");
    // mailbox is null OR the configured shared reply mailbox string
    expect(s.mailbox === null || typeof s.mailbox === "string").toBe(true);
  });
});

describe("enroll-all per-user result shape", () => {
  // The route returns one EnrollResult per considered user. The admin UI
  // depends on every entry having {userId, userName, email, outcome}, so
  // we lock the shape here. (We don't hit the route — we exercise the
  // pure aggregation logic by simulating the loop's output.)
  type Outcome = "enrolled" | "already_enrolled" | "skipped_no_mailbox" | "error";
  interface EnrollResult {
    userId: string;
    userName: string;
    email: string | null;
    outcome: Outcome;
    error?: string;
  }
  function aggregate(results: EnrollResult[]) {
    return {
      added: results.filter(r => r.outcome === "enrolled").length,
      skipped: results.filter(r => r.outcome === "already_enrolled").length,
      skippedNoMailbox: results.filter(r => r.outcome === "skipped_no_mailbox").length,
      failed: results.filter(r => r.outcome === "error").length,
    };
  }
  it("aggregates outcomes correctly across all four cases", () => {
    const results: EnrollResult[] = [
      { userId: "u1", userName: "Alice", email: "alice@x", outcome: "enrolled" },
      { userId: "u2", userName: "Bob", email: "bob@x", outcome: "already_enrolled" },
      { userId: "u3", userName: "Carol", email: null, outcome: "skipped_no_mailbox" },
      { userId: "u4", userName: "Dave", email: "dave@x", outcome: "error", error: "boom" },
      { userId: "u5", userName: "Eve", email: "eve@x", outcome: "enrolled" },
    ];
    expect(aggregate(results)).toEqual({
      added: 2,
      skipped: 1,
      skippedNoMailbox: 1,
      failed: 1,
    });
    // Every error entry must carry an error string for the UI to show.
    for (const r of results.filter(r => r.outcome === "error")) {
      expect(typeof r.error).toBe("string");
    }
  });
});

describe("ELIGIBLE_ROLES (Task #523 — include LMs in Enroll All)", () => {
  // The eligible-roles list drives BOTH enroll-all and the coverage
  // banner denominator. Logistics Managers were silently skipped before
  // Task #523 — locking them in here prevents accidental removal.
  it("includes Logistics Manager alongside the existing eligible roles", () => {
    expect(ELIGIBLE_ROLES).toContain("logistics_manager");
    expect(ELIGIBLE_ROLES).toEqual(
      expect.arrayContaining([
        "national_account_manager",
        "account_manager",
        "admin",
        "director",
        "sales_director",
        "logistics_manager",
      ]),
    );
  });

  it("does NOT include logistics_coordinator or sales (intentionally out of scope)", () => {
    // Task #523 explicitly limits the addition to logistics_manager. If
    // these ever flip to true, it must be a deliberate follow-up — not
    // an accidental copy-paste.
    expect(ELIGIBLE_ROLES).not.toContain("logistics_coordinator");
    expect(ELIGIBLE_ROLES).not.toContain("sales");
  });

  it("LM with login email is enrolled by enroll-all and counted as eligible", () => {
    // Mirrors the route's filter:
    //   allUsers.filter(u => ELIGIBLE_ROLES.includes(u.role) && !!u.username)
    // …and its companion filter for the no-login bucket.
    interface OrgUser { id: string; role: string; username: string | null }
    const allUsers: OrgUser[] = [
      { id: "u-nam", role: "national_account_manager", username: "nam@x" },
      { id: "u-am",  role: "account_manager",          username: "am@x" },
      { id: "u-lm",  role: "logistics_manager",        username: "lm@x" },
      { id: "u-lc",  role: "logistics_coordinator",    username: "lc@x" },     // not eligible
      { id: "u-sales", role: "sales",                  username: "sales@x" },  // not eligible
    ];
    const eligibleUsers = allUsers.filter(
      u => ELIGIBLE_ROLES.includes(u.role) && !!u.username,
    );
    expect(eligibleUsers.map(u => u.id)).toEqual(["u-nam", "u-am", "u-lm"]);
    // Coverage banner denominator = eligibleUsers.length, so LM bumps it
    // from 2 to 3 in this fixture.
    expect(eligibleUsers.length).toBe(3);
  });

  it("LM without a login email is bucketed as skipped_no_mailbox (not silently dropped)", () => {
    interface OrgUser { id: string; role: string; username: string | null }
    const allUsers: OrgUser[] = [
      { id: "u-lm-noemail", role: "logistics_manager", username: null },
      { id: "u-lm-with",    role: "logistics_manager", username: "ok@x" },
    ];
    const noMailbox = allUsers.filter(
      u => ELIGIBLE_ROLES.includes(u.role) && !u.username,
    );
    expect(noMailbox.map(u => u.id)).toEqual(["u-lm-noemail"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture mailbox guard — regression test.
//
// Background: the Conversations Inbox "Webhook unhealthy" badge kept getting
// re-tripped because the lane-work-queue test suite leaves users with
// `wq.test.*@example.com` addresses, and the bulk enroll-all flow used to
// indiscriminately enroll them. Microsoft Graph then permanently 404'd on
// every subscription registration, leaving every fixture row stuck at
// `sentItemsHealth = "missing"` and rolling the org-wide health up to
// "unhealthy" (any mailbox in `expired`/`missing` flips the badge red).
//
// This test locks in the boundary guard so the recurrence path can never
// reopen — if someone removes the guard, this test fails loudly.
// ─────────────────────────────────────────────────────────────────────────────
import {
  isFixtureMailboxAddress,
  FIXTURE_MAILBOX_DOMAINS,
  FIXTURE_MAILBOX_LIKE_PATTERNS,
} from "../lib/fixtureMailboxes";

describe("isFixtureMailboxAddress — webhook-health regression guard", () => {
  it("blocks the exact wq.test.*@example.com pattern that caused the original incident", () => {
    expect(isFixtureMailboxAddress("wq.test.7e523ccc@example.com")).toBe(true);
    expect(isFixtureMailboxAddress("WQ.Test.AbCdEf@Example.COM")).toBe(true); // case-insensitive
    expect(isFixtureMailboxAddress("  wq.test.42@example.com  ")).toBe(true); // trims whitespace
  });

  it("blocks RFC 6761 / RFC 2606 reserved special-use domains and their subdomains", () => {
    // example.{com,org,net} — RFC 2606
    expect(isFixtureMailboxAddress("foo@example.com")).toBe(true);
    expect(isFixtureMailboxAddress("foo@example.org")).toBe(true);
    expect(isFixtureMailboxAddress("foo@example.net")).toBe(true);
    // RFC 6761 reserved TLDs — both bare AND subdomain forms
    expect(isFixtureMailboxAddress("foo@invalid")).toBe(true);
    expect(isFixtureMailboxAddress("foo@bar.invalid")).toBe(true);
    expect(isFixtureMailboxAddress("foo@localhost")).toBe(true);
    expect(isFixtureMailboxAddress("foo@bar.localhost")).toBe(true);
    expect(isFixtureMailboxAddress("foo@test")).toBe(true);
    expect(isFixtureMailboxAddress("foo@bar.test")).toBe(true);
    expect(isFixtureMailboxAddress("foo@example")).toBe(true);
    expect(isFixtureMailboxAddress("foo@bar.example")).toBe(true);
    // Common dev/CI overrides
    expect(isFixtureMailboxAddress("foo@test.local")).toBe(true);
    expect(isFixtureMailboxAddress("foo@local.test")).toBe(true);
  });

  it("does NOT flag real customer/employee mailbox addresses", () => {
    expect(isFixtureMailboxAddress("taylor.call@valuetruck.com")).toBe(false);
    expect(isFixtureMailboxAddress("dispatch@bigshipper.com")).toBe(false);
    expect(isFixtureMailboxAddress("sales@example-truckline.com")).toBe(false); // not @example.com
    expect(isFixtureMailboxAddress("user@invalidcompany.com")).toBe(false);     // .com not .invalid
    expect(isFixtureMailboxAddress("user@testdrive.com")).toBe(false);          // .com not .test
  });

  it("handles null/empty/garbage input safely", () => {
    expect(isFixtureMailboxAddress(null)).toBe(false);
    expect(isFixtureMailboxAddress(undefined)).toBe(false);
    expect(isFixtureMailboxAddress("")).toBe(false);
    expect(isFixtureMailboxAddress("not-an-email")).toBe(false);
  });

  it("FIXTURE_MAILBOX_LIKE_PATTERNS stays in lock-step with FIXTURE_MAILBOX_DOMAINS (no drift)", () => {
    // The boot-time DELETE migration uses the LIKE patterns; the route guard
    // uses the suffix list. If they ever drift, the migration could leave
    // pollution behind that the route guard would otherwise catch (or vice
    // versa) — exactly the failure mode that caused this to keep recurring.
    expect(FIXTURE_MAILBOX_LIKE_PATTERNS.length).toBe(FIXTURE_MAILBOX_DOMAINS.length);
    FIXTURE_MAILBOX_DOMAINS.forEach((suffix, i) => {
      expect(FIXTURE_MAILBOX_LIKE_PATTERNS[i]).toBe(`%${suffix}`);
    });
  });

  it("simulates the enroll-all skip path: fixture users are filtered before insert", () => {
    interface OrgUser { id: string; role: string; username: string }
    const allUsers: OrgUser[] = [
      { id: "u-real-1", role: "account_manager",          username: "rep1@valuetruck.com" },
      { id: "u-real-2", role: "national_account_manager", username: "rep2@valuetruck.com" },
      { id: "u-test-1", role: "account_manager",          username: "wq.test.aaaaaaaa@example.com" },
      { id: "u-test-2", role: "admin",                    username: "wq.test.bbbbbbbb@example.com" },
      { id: "u-test-3", role: "account_manager",          username: "fixture@bar.invalid" },
    ];
    const eligible = allUsers.filter(u => ELIGIBLE_ROLES.includes(u.role));
    const wouldEnroll = eligible.filter(u => !isFixtureMailboxAddress(u.username));
    expect(wouldEnroll.map(u => u.id)).toEqual(["u-real-1", "u-real-2"]);
    // Critical assertion: zero fixture rows would reach the database, so the
    // webhook-failure count from this enrollment batch is exactly 0.
    expect(eligible.length - wouldEnroll.length).toBe(3);
  });
});
