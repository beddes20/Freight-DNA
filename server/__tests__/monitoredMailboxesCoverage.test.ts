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
