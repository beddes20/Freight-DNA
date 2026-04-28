/**
 * Email Response Time Analytics — Service Tests (Task #602).
 *
 * Covers pure helpers in emailResponseTimeAnalyticsService.ts:
 *   • stripEmailAlias / resolveSenderUserId — alias + shared-inbox + miss
 *   • attributedSenderId — sender > owner > unattributed precedence
 *   • buildLeaderboard — credits resolved sender, includes Unattributed row
 *   • buildSlowestThreads — unattributedOnly filter + waiting age computation
 *   • buildRightNow — age-bucket counts + topOverdueRep + oldest waiting
 *   • buildSlaCompliance — % within target with biz vs wall-clock ms
 *   • buildAccountOutliers — accounts ≥ N× org median (with floor on count)
 *   • buildHeatmap — weekday × hour grid sized 7×24 with median ms
 *   • etDayOfWeekHour — DST-correct ET mapping
 *   • businessHoursMs — weekend / off-hours exclusion
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the storage module so fetchResponsePairs's pool.query calls are
// fully under test control. Only what fetchResponsePairs and
// buildSenderUserDirectory touch is needed.
const mockQuery = vi.fn();
vi.mock("../storage", () => ({
  storage: { pool: { query: (...args: unknown[]) => mockQuery(...args) } },
  db: {},
}));

import {
  stripEmailAlias,
  resolveSenderUserId,
  attributedSenderId,
  attributedSenderName,
  buildLeaderboard,
  buildSlowestThreads,
  buildRightNow,
  buildSlaCompliance,
  buildAccountOutliers,
  buildHeatmap,
  etDayOfWeekHour,
  businessHoursMs,
  fetchResponsePairs,
  UNATTRIBUTED_SENDER_ID,
  type ResponsePair,
  type SenderUserDirectory,
  type SlaTarget,
} from "../services/emailResponseTimeAnalyticsService";

function makeDirectory(): SenderUserDirectory {
  // Manually construct a directory rather than calling the DB-backed builder.
  const byEmail = new Map();
  const byBaseEmail = new Map();
  const add = (email: string, userId: string, name: string) => {
    const lower = email.toLowerCase();
    const entry = { userId, name, email: lower };
    if (!byEmail.has(lower)) byEmail.set(lower, entry);
    const base = stripEmailAlias(lower);
    if (!byBaseEmail.has(base)) byBaseEmail.set(base, entry);
  };
  add("alice@acme.com", "u-alice", "Alice");
  add("bob@acme.com", "u-bob", "Bob");
  add("sales@acme.com", "u-bob", "Bob"); // shared inbox owned by Bob
  return {
    byEmail,
    byBaseEmail,
    users: [
      { id: "u-alice", name: "Alice", username: "alice@acme.com" },
      { id: "u-bob", name: "Bob", username: "bob@acme.com" },
    ],
  };
}

function pair(overrides: Partial<ResponsePair> & { id: string }): ResponsePair {
  const inboundAt = overrides.inboundAt ?? new Date("2026-04-15T13:00:00Z");
  const outboundAt = overrides.outboundAt === undefined ? new Date("2026-04-15T14:00:00Z") : overrides.outboundAt;
  const computedWall = outboundAt ? outboundAt.getTime() - inboundAt.getTime() : null;
  const wallMs = overrides.wallMs !== undefined ? overrides.wallMs : computedWall;
  const bizMs = overrides.bizMs !== undefined ? overrides.bizMs : wallMs;
  return {
    inboundId: overrides.id,
    threadId: overrides.threadId ?? `t-${overrides.id}`,
    inboundAt,
    outboundAt,
    ownerUserId: overrides.ownerUserId ?? null,
    ownerName: overrides.ownerName ?? null,
    senderUserId: overrides.senderUserId ?? null,
    senderName: overrides.senderName ?? null,
    accountId: overrides.accountId ?? "acct-1",
    accountName: overrides.accountName ?? "Acct One",
    subject: overrides.subject ?? `Subject ${overrides.id}`,
    fromEmail: overrides.fromEmail ?? null,
    wallMs,
    bizMs,
  };
}

describe("stripEmailAlias", () => {
  it("removes +suffix and lowercases", () => {
    expect(stripEmailAlias("Rep+Invoices@Example.COM")).toBe("rep@example.com");
  });
  it("returns lowercase email when no alias present", () => {
    expect(stripEmailAlias("rep@example.com")).toBe("rep@example.com");
  });
  it("handles malformed values without throwing", () => {
    expect(stripEmailAlias("notanemail")).toBe("notanemail");
  });
});

describe("resolveSenderUserId", () => {
  const directory = makeDirectory();

  it("resolves an exact match", () => {
    const r = resolveSenderUserId("alice@acme.com", directory);
    expect(r).toEqual({ userId: "u-alice", name: "Alice" });
  });

  it("resolves a +alias match by stripping suffix", () => {
    const r = resolveSenderUserId("Bob+Quotes@acme.com", directory);
    expect(r).toEqual({ userId: "u-bob", name: "Bob" });
  });

  it("resolves a shared-inbox alias to its monitored owner", () => {
    const r = resolveSenderUserId("sales@acme.com", directory);
    expect(r?.userId).toBe("u-bob");
  });

  it("returns null when nothing matches", () => {
    expect(resolveSenderUserId("stranger@elsewhere.com", directory)).toBeNull();
    expect(resolveSenderUserId(null, directory)).toBeNull();
    expect(resolveSenderUserId("", directory)).toBeNull();
  });
});

describe("attributedSenderId precedence", () => {
  it("prefers resolved sender", () => {
    const p = pair({ id: "1", senderUserId: "u-bob", ownerUserId: "u-alice" });
    expect(attributedSenderId(p)).toBe("u-bob");
    expect(attributedSenderName(p)).toBe(p.senderName ?? "Unknown");
  });
  it("falls back to owner", () => {
    const p = pair({ id: "2", ownerUserId: "u-alice", ownerName: "Alice" });
    expect(attributedSenderId(p)).toBe("u-alice");
    expect(attributedSenderName(p)).toBe("Alice");
  });
  it("falls back to Unattributed sentinel", () => {
    const p = pair({ id: "3" });
    expect(attributedSenderId(p)).toBe(UNATTRIBUTED_SENDER_ID);
    expect(attributedSenderName(p)).toBe("Unattributed");
  });
});

describe("buildLeaderboard", () => {
  it("credits resolved sender even without an owner, and adds Unattributed row", () => {
    const pairs: ResponsePair[] = [
      pair({ id: "1", senderUserId: "u-alice", senderName: "Alice", ownerUserId: null }),
      pair({ id: "2", senderUserId: "u-alice", senderName: "Alice", ownerUserId: null }),
      pair({ id: "3", senderUserId: "u-bob", senderName: "Bob", ownerUserId: null }),
      pair({ id: "4" }), // unattributed reply
      // waiting w/ owner Alice
      pair({ id: "5", outboundAt: null, ownerUserId: "u-alice", ownerName: "Alice" }),
      // waiting w/o owner — counts in Unattributed waiting bucket
      pair({ id: "6", outboundAt: null, ownerUserId: null }),
    ];
    const rows = buildLeaderboard(pairs, false);
    const alice = rows.find((r) => r.ownerUserId === "u-alice")!;
    const bob = rows.find((r) => r.ownerUserId === "u-bob")!;
    const un = rows.find((r) => r.ownerUserId === UNATTRIBUTED_SENDER_ID)!;
    expect(alice.count).toBe(2);
    expect(alice.waiting).toBe(1);
    expect(bob.count).toBe(1);
    expect(un.count).toBe(1);
    expect(un.waiting).toBe(1);
    expect(un.unattributed).toBe(true);
    // Unattributed always sorts last.
    expect(rows[rows.length - 1].ownerUserId).toBe(UNATTRIBUTED_SENDER_ID);
  });

  // Task #798 — leaderboard rows carry a cohort derived from the rep's
  // role so the client can split into Customer Facing (NAM/AM) vs
  // Carrier Facing (LM) tabs.
  it("tags each rep with role/cohort and leaves Unattributed null", () => {
    const pairs: ResponsePair[] = [
      pair({ id: "1", senderUserId: "u-nam", senderName: "Nina NAM" }),
      pair({ id: "2", senderUserId: "u-am", senderName: "Alex AM" }),
      pair({ id: "3", senderUserId: "u-lm", senderName: "Luca LM" }),
      pair({ id: "4", senderUserId: "u-coord", senderName: "Casey Coord" }),
      pair({ id: "5" }), // unattributed reply
    ];
    const roles = new Map<string, string | null>([
      ["u-nam", "national_account_manager"],
      ["u-am", "account_manager"],
      ["u-lm", "logistics_manager"],
      ["u-coord", "logistics_coordinator"],
    ]);
    const rows = buildLeaderboard(pairs, false, roles);
    const find = (id: string) => rows.find((r) => r.ownerUserId === id)!;
    expect(find("u-nam").role).toBe("national_account_manager");
    expect(find("u-nam").cohort).toBe("customer");
    expect(find("u-am").cohort).toBe("customer");
    expect(find("u-lm").cohort).toBe("carrier");
    // Logistics coordinators (and any role outside NAM/AM/LM) are excluded
    // from both cohorts by getting a null cohort.
    expect(find("u-coord").role).toBe("logistics_coordinator");
    expect(find("u-coord").cohort).toBeNull();
    const un = find(UNATTRIBUTED_SENDER_ID);
    expect(un.role).toBeNull();
    expect(un.cohort).toBeNull();
  });

  it("falls back to null role/cohort when no role map is provided", () => {
    const pairs: ResponsePair[] = [
      pair({ id: "1", senderUserId: "u-alice", senderName: "Alice" }),
    ];
    const rows = buildLeaderboard(pairs, false);
    const alice = rows.find((r) => r.ownerUserId === "u-alice")!;
    expect(alice.role).toBeNull();
    expect(alice.cohort).toBeNull();
  });
});

describe("buildSlowestThreads", () => {
  const now = new Date("2026-04-20T16:00:00Z");
  const baseInbound = new Date("2026-04-20T08:00:00Z"); // 8h ago
  const pairs: ResponsePair[] = [
    pair({ id: "responded", outboundAt: new Date("2026-04-20T08:30:00Z"), wallMs: 30 * 60 * 1000, bizMs: 30 * 60 * 1000, ownerUserId: "u-alice", ownerName: "Alice" }),
    pair({ id: "wait-with-owner", outboundAt: null, inboundAt: baseInbound, ownerUserId: "u-alice", ownerName: "Alice" }),
    pair({ id: "wait-no-owner", outboundAt: null, inboundAt: baseInbound, ownerUserId: null }),
  ];

  it("computes age for waiting threads using now − inboundAt", () => {
    const rows = buildSlowestThreads(pairs, false, now, 10);
    const wait = rows.find((r) => r.inboundId === "wait-with-owner")!;
    expect(wait.isWaiting).toBe(true);
    expect(wait.ageMs).toBe(8 * 60 * 60 * 1000);
  });

  it("filters to unattributed only when requested", () => {
    const rows = buildSlowestThreads(pairs, false, now, 10, { unattributedOnly: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].inboundId).toBe("wait-no-owner");
    expect(rows[0].unattributed).toBe(true);
  });

  it("sorts by ageMs descending", () => {
    const rows = buildSlowestThreads(pairs, false, now, 10);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].ageMs).toBeGreaterThanOrEqual(rows[i].ageMs);
    }
  });
});

describe("buildRightNow", () => {
  const now = new Date("2026-04-20T20:00:00Z");
  const pairs: ResponsePair[] = [
    // 5 hours waiting on Alice
    pair({ id: "w1", outboundAt: null, inboundAt: new Date("2026-04-20T15:00:00Z"), ownerUserId: "u-alice", ownerName: "Alice" }),
    // 26 hours waiting on Alice
    pair({ id: "w2", outboundAt: null, inboundAt: new Date("2026-04-19T18:00:00Z"), ownerUserId: "u-alice", ownerName: "Alice" }),
    // 30 minutes waiting on Bob (well under 1h)
    pair({ id: "w3", outboundAt: null, inboundAt: new Date("2026-04-20T19:30:00Z"), ownerUserId: "u-bob", ownerName: "Bob" }),
  ];
  const snap = buildRightNow(pairs, false, now);

  it("counts waiting age buckets correctly", () => {
    expect(snap.waitingTotal).toBe(3);
    expect(snap.waitingOver1h).toBe(2);
    expect(snap.waitingOver4h).toBe(2);
    expect(snap.waitingOver24h).toBe(1);
  });
  it("identifies the oldest waiting thread", () => {
    expect(snap.oldestWaiting?.inboundId).toBe("w2");
  });
  it("identifies the rep with most overdue (>4h) threads", () => {
    expect(snap.topOverdueRep?.ownerUserId).toBe("u-alice");
    expect(snap.topOverdueRep?.overdueCount).toBe(2);
  });

  it("surfaces a multi-month-old waiting thread (no implicit horizon truncation)", () => {
    // Regression: the /right-now route used to forcibly cap the lookback to
    // the last 30 days, silently hiding any older unanswered customer email.
    // This test asserts the helper itself handles arbitrarily old waiting
    // threads — the route now passes a 2-year lookback so the helper can do
    // its job. Caller is responsible for fetching across the right horizon.
    const now2 = new Date("2026-04-20T20:00:00Z");
    // 90 days waiting on Dave — older than the previous 30-day cap.
    const inboundLongAgo = new Date(now2.getTime() - 90 * 24 * 60 * 60 * 1000);
    const ancient: ResponsePair[] = [
      pair({
        id: "w-90d",
        outboundAt: null,
        inboundAt: inboundLongAgo,
        ownerUserId: "u-dave",
        ownerName: "Dave",
      }),
    ];
    const out = buildRightNow(ancient, false, now2);
    expect(out.oldestWaiting).not.toBeNull();
    expect(out.oldestWaiting?.inboundId).toBe("w-90d");
    expect(out.waitingTotal).toBe(1);
    expect(out.waitingOver1h).toBe(1);
    expect(out.waitingOver4h).toBe(1);
    expect(out.waitingOver24h).toBe(1);
    expect(out.topOverdueRep?.ownerUserId).toBe("u-dave");
    expect(out.topOverdueRep?.overdueCount).toBe(1);
  });

  it("preserves waiting rows even when responded rows vastly outnumber them", () => {
    // Regression: previously buildRightNow routed pairs through
    // buildSlowestThreads(..., 10000), which sorts mixed responded+waiting
    // rows by ageMs and slices. In an org with thousands of slow responded
    // threads, waiting rows could fall off the cut. This test simulates that
    // imbalance and asserts the waiting thread still surfaces.
    const now2 = new Date("2026-04-20T20:00:00Z");
    const HOUR = 60 * 60 * 1000;
    const responded: ResponsePair[] = Array.from({ length: 12000 }, (_, i) =>
      pair({
        id: `r${i}`,
        inboundAt: new Date(now2.getTime() - 100 * HOUR), // 100h-old responded
        outboundAt: new Date(now2.getTime() - 1 * HOUR),
        ownerUserId: "u-x",
        ownerName: "Xena",
      }),
    );
    const waiting: ResponsePair[] = [
      pair({
        id: "w-late",
        outboundAt: null,
        inboundAt: new Date(now2.getTime() - 6 * HOUR), // 6h waiting
        ownerUserId: "u-y",
        ownerName: "Yael",
      }),
    ];
    const out = buildRightNow([...responded, ...waiting], false, now2);
    expect(out.waitingTotal).toBe(1);
    expect(out.oldestWaiting?.inboundId).toBe("w-late");
    expect(out.waitingOver1h).toBe(1);
    expect(out.waitingOver4h).toBe(1);
    expect(out.waitingOver24h).toBe(0);
  });

  it("returns the oldest WAITING thread even when a responded thread is older", () => {
    // Regression for the buildRightNow oldestWaiting bug:
    // a 48h-old responded thread must NOT shadow a 26h-old waiting thread.
    const now2 = new Date("2026-04-20T20:00:00Z");
    const mixed: ResponsePair[] = [
      // Responded but 48h between in/out — would have ageMs=48h via buildSlowestThreads
      pair({
        id: "r-old",
        outboundAt: new Date("2026-04-20T19:00:00Z"),
        inboundAt: new Date("2026-04-18T19:00:00Z"),
        ownerUserId: "u-c",
        ownerName: "Carol",
      }),
      // Waiting, 26h old
      pair({
        id: "w-26",
        outboundAt: null,
        inboundAt: new Date("2026-04-19T18:00:00Z"),
        ownerUserId: "u-c",
        ownerName: "Carol",
      }),
    ];
    const out = buildRightNow(mixed, false, now2);
    expect(out.oldestWaiting).not.toBeNull();
    expect(out.oldestWaiting?.inboundId).toBe("w-26");
  });
});

describe("buildSlaCompliance", () => {
  const targets: SlaTarget[] = [
    { label: "1h", ms: 60 * 60 * 1000, businessHours: false },
    { label: "4h", ms: 4 * 60 * 60 * 1000, businessHours: false },
  ];
  const pairs: ResponsePair[] = [
    pair({ id: "a", wallMs: 30 * 60 * 1000, bizMs: 30 * 60 * 1000 }),
    pair({ id: "b", wallMs: 90 * 60 * 1000, bizMs: 90 * 60 * 1000 }),
    pair({ id: "c", wallMs: 5 * 60 * 60 * 1000, bizMs: 5 * 60 * 60 * 1000 }),
    pair({ id: "d", outboundAt: null }), // ignored — waiting
  ];
  const compliance = buildSlaCompliance(pairs, targets);
  it("computes within-target counts and percentages", () => {
    const oneHr = compliance.find((c) => c.label === "1h")!;
    expect(oneHr.total).toBe(3);
    expect(oneHr.withinTarget).toBe(1);
    expect(oneHr.pct).toBeCloseTo(33.33, 1);
    const fourHr = compliance.find((c) => c.label === "4h")!;
    expect(fourHr.withinTarget).toBe(2);
  });
});

describe("buildAccountOutliers", () => {
  it("flags accounts ≥ N× org median, ignoring tiny samples", () => {
    // Bias org median toward the fast bucket so the slow account is clearly
    // an outlier. 10 fast at 30m + 3 slow at 4h → org median = 30m, slow
    // median = 4h, multiplier = 8×.
    const fast = Array.from({ length: 10 }, (_, i) =>
      pair({ id: `f${i}`, accountId: "acct-fast", accountName: "Fast Co", wallMs: 30 * 60 * 1000, bizMs: 30 * 60 * 1000 }),
    );
    const slow = Array.from({ length: 3 }, (_, i) =>
      pair({ id: `s${i}`, accountId: "acct-slow", accountName: "Slow Co", wallMs: 4 * 60 * 60 * 1000, bizMs: 4 * 60 * 60 * 1000 }),
    );
    const tinyButSlow = [
      // Single-reply account — must be skipped despite being slow.
      pair({ id: "t1", accountId: "acct-tiny", accountName: "Tiny", wallMs: 12 * 60 * 60 * 1000, bizMs: 12 * 60 * 60 * 1000 }),
    ];
    const outliers = buildAccountOutliers([...fast, ...slow, ...tinyButSlow], false, 2);
    const slowOut = outliers.find((o) => o.accountId === "acct-slow");
    const tinyOut = outliers.find((o) => o.accountId === "acct-tiny");
    expect(slowOut).toBeTruthy();
    expect(slowOut!.multiplier).toBeGreaterThanOrEqual(2);
    // Tiny sample (<3 replies) is skipped to avoid noise.
    expect(tinyOut).toBeUndefined();
  });
});

describe("buildHeatmap", () => {
  it("returns a complete 7×24 grid", () => {
    const cells = buildHeatmap([], false);
    expect(cells).toHaveLength(7 * 24);
    for (const c of cells) {
      expect(c.count).toBe(0);
      expect(c.medianMs).toBeNull();
    }
  });

  it("buckets responses by ET day-of-week and hour", () => {
    // 2026-04-15 14:00 UTC = 10am ET (EDT); weekday Wed.
    const out = new Date("2026-04-15T14:00:00Z");
    const inbound = new Date("2026-04-15T13:00:00Z");
    const pairs: ResponsePair[] = [
      pair({ id: "h1", inboundAt: inbound, outboundAt: out, wallMs: 60 * 60 * 1000, bizMs: 60 * 60 * 1000 }),
    ];
    const cells = buildHeatmap(pairs, false);
    const target = cells.find((c) => c.weekday === 3 && c.hour === 10);
    expect(target?.count).toBe(1);
    expect(target?.medianMs).toBe(60 * 60 * 1000);
  });
});

describe("etDayOfWeekHour", () => {
  it("maps a UTC time to the correct ET hour during DST", () => {
    // April 15 2026 14:00 UTC → 10:00 ET (EDT, UTC-4).
    expect(etDayOfWeekHour(new Date("2026-04-15T14:00:00Z"))).toEqual({ weekday: 3, hour: 10 });
  });
  it("maps a UTC time to the correct ET hour during standard time", () => {
    // Jan 15 2026 14:00 UTC → 09:00 ET (EST, UTC-5).
    expect(etDayOfWeekHour(new Date("2026-01-15T14:00:00Z"))).toEqual({ weekday: 4, hour: 9 });
  });
});

describe("businessHoursMs", () => {
  it("returns 0 when the entire window is on a weekend", () => {
    // Sat 2026-04-18 12:00 ET → Sat 2026-04-18 20:00 ET.
    const start = Date.UTC(2026, 3, 18, 16, 0, 0);
    const end = Date.UTC(2026, 3, 19, 0, 0, 0);
    expect(businessHoursMs(start, end)).toBe(0);
  });

  it("includes only the 8a–6p portion within a single weekday", () => {
    // Wed 2026-04-15 06:00 ET → 21:00 ET → expect 10h business window.
    const start = Date.UTC(2026, 3, 15, 10, 0, 0); // 06:00 ET
    const end = Date.UTC(2026, 3, 16, 1, 0, 0);    // 21:00 ET same day
    const tenHours = 10 * 60 * 60 * 1000;
    expect(businessHoursMs(start, end)).toBe(tenHours);
  });

  it("skips weekend hours when window spans Fri→Mon", () => {
    // Fri 2026-04-17 08:00 ET → Mon 2026-04-20 18:00 ET.
    // Expected: 10h Fri + 10h Mon = 20h.
    const start = Date.UTC(2026, 3, 17, 12, 0, 0);  // 08:00 ET
    const end = Date.UTC(2026, 3, 20, 22, 0, 0);    // 18:00 ET
    expect(businessHoursMs(start, end)).toBe(20 * 60 * 60 * 1000);
  });
});

describe("fetchResponsePairs waiting-clear semantics", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  // Helper to dispatch the four queries fetchResponsePairs makes against the
  // shape of each query string. Order is non-deterministic because the
  // sqlReplies + sqlLatestInbound queries run in parallel via Promise.all.
  function setupMocks(opts: {
    users: Array<{ id: string; name: string | null; username: string }>;
    mailboxes: Array<{ user_id: string; email: string }>;
    replies: Array<Record<string, unknown>>;
    latestInbounds: Array<Record<string, unknown>>;
    outbounds: Array<{ thread_id: string; from_email: string | null; outbound_at: string }>;
  }) {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE organization_id")) return { rows: opts.users };
      if (sql.includes("FROM monitored_mailboxes")) return { rows: opts.mailboxes };
      if (sql.includes("FROM email_messages em")) return { rows: opts.replies };
      if (sql.includes("DISTINCT ON (inb.thread_id)")) return { rows: opts.latestInbounds };
      if (sql.includes("AND direction = 'outbound'")) return { rows: opts.outbounds };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    });
  }

  it("clears waiting on an unassigned thread when an unattributed outbound replies after inbound", async () => {
    // Regression: previously, an unassigned thread (owner_user_id = null)
    // whose only outbound reply came from an address not in the user/mailbox
    // directory would BOTH appear as a reply event AND remain in the
    // still-waiting bucket, double-counting in the leaderboard.
    setupMocks({
      users: [{ id: "u-alice", name: "Alice", username: "alice@acme.com" }],
      mailboxes: [],
      // The reply event itself — outbound from an unmatched forwarder address.
      replies: [
        {
          row_id: "out-1",
          thread_id: "th-A",
          outbound_at: "2026-04-15T15:00:00Z",
          from_email: "forwarder@external.example", // NOT in directory
          subject: "Re: ping",
          account_id: "acct-X",
          owner_user_id: null,
          owner_name: null,
          account_name: "Acct X",
          inbound_at: "2026-04-15T14:00:00Z",
        },
      ],
      latestInbounds: [
        {
          row_id: "in-1",
          thread_id: "th-A",
          org_id: "org-1",
          inbound_at: "2026-04-15T14:00:00Z",
          from_email: "customer@acct.example",
          subject: "ping",
          account_id: "acct-X",
          owner_user_id: null, // unassigned thread
          owner_name: null,
          account_name: "Acct X",
        },
      ],
      outbounds: [
        // Same outbound reply — must clear the wait even though sender
        // doesn't resolve and thread has no owner.
        {
          thread_id: "th-A",
          from_email: "forwarder@external.example",
          outbound_at: "2026-04-15T15:00:00Z",
        },
      ],
    });

    const pairs = await fetchResponsePairs({
      orgId: "org-1",
      start: new Date("2026-04-15T00:00:00Z"),
      end: new Date("2026-04-16T00:00:00Z"),
      businessHours: false,
    });

    // One reply event, ZERO waiting. No double-counting.
    expect(pairs.length).toBe(1);
    expect(pairs[0].outboundAt).not.toBeNull();
    expect(pairs[0].threadId).toBe("th-A");
    expect(pairs.filter((p) => p.outboundAt === null).length).toBe(0);
  });

  it("rep filter credits a sender for replies on threads owned by another rep", async () => {
    // Comment-driven coverage: when filtering by repIds, attribution
    // semantics apply — a rep gets credit for replies they ACTUALLY sent
    // (sender match) on threads owned by someone else or unassigned, not
    // only on threads they own.
    setupMocks({
      users: [
        { id: "u-alice", name: "Alice", username: "alice@acme.com" },
        { id: "u-bob", name: "Bob", username: "bob@acme.com" },
      ],
      mailboxes: [],
      // Two replies in the window:
      //  • out-1: thread owned by Bob, but Alice actually replied.
      //  • out-2: thread owned by Bob, Bob replied — should NOT match a
      //    rep-filter for Alice.
      replies: [
        {
          row_id: "out-1",
          thread_id: "th-1",
          outbound_at: "2026-04-15T15:00:00Z",
          from_email: "alice@acme.com",
          subject: "Re: ping",
          account_id: "acct-X",
          owner_user_id: "u-bob",
          owner_name: "Bob",
          account_name: "Acct X",
          inbound_at: "2026-04-15T14:00:00Z",
        },
        {
          row_id: "out-2",
          thread_id: "th-2",
          outbound_at: "2026-04-15T16:00:00Z",
          from_email: "bob@acme.com",
          subject: "Re: pong",
          account_id: "acct-Y",
          owner_user_id: "u-bob",
          owner_name: "Bob",
          account_name: "Acct Y",
          inbound_at: "2026-04-15T15:00:00Z",
        },
      ],
      latestInbounds: [],
      outbounds: [],
    });

    const pairs = await fetchResponsePairs({
      orgId: "org-1",
      start: new Date("2026-04-15T00:00:00Z"),
      end: new Date("2026-04-16T00:00:00Z"),
      businessHours: false,
      repIds: ["u-alice"],
    });

    expect(pairs.length).toBe(1);
    expect(pairs[0].threadId).toBe("th-1");
    expect(pairs[0].senderUserId).toBe("u-alice");
  });

  it("includes today's customer-mailbox replies even when linked_account_id is null (Task #749 — leaderboard attribution gap)", async () => {
    // Regression: prior to #749 the SQL filter required
    //   COALESCE(ect.linked_account_id, em.linked_account_id) IS NOT NULL
    // which dropped almost every "today" reply because contact-match hadn't
    // tagged the thread with a CRM company yet — leaving the leaderboard
    // crediting a single rep while many reps had clearly replied. The fix
    // switches the lane discriminator to em.linked_outreach_log_id IS NULL,
    // so we assert the SQL that's actually issued contains the new filter
    // and that rows from multiple senders without account_id flow through.
    let repliesSqlCaptured: string | null = null;
    let inboundsSqlCaptured: string | null = null;
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE organization_id")) {
        return {
          rows: [
            { id: "u-alice", name: "Alice", username: "alice@acme.com" },
            { id: "u-bob",   name: "Bob",   username: "bob@acme.com" },
          ],
        };
      }
      if (sql.includes("FROM monitored_mailboxes")) return { rows: [] };
      if (sql.includes("FROM email_messages em")) {
        repliesSqlCaptured = sql;
        return {
          rows: [
            {
              row_id: "out-A", thread_id: "th-A",
              outbound_at: "2026-04-27T15:00:00Z",
              from_email: "alice@acme.com", subject: "Re: hello",
              account_id: null,            // ← contact-match never ran
              owner_user_id: "u-alice", owner_name: "Alice",
              account_name: null,
              inbound_at: "2026-04-27T14:00:00Z",
            },
            {
              row_id: "out-B", thread_id: "th-B",
              outbound_at: "2026-04-27T15:30:00Z",
              from_email: "bob@acme.com", subject: "Re: world",
              account_id: null,            // ← contact-match never ran
              owner_user_id: "u-bob", owner_name: "Bob",
              account_name: null,
              inbound_at: "2026-04-27T15:00:00Z",
            },
          ],
        };
      }
      if (sql.includes("DISTINCT ON (inb.thread_id)")) {
        inboundsSqlCaptured = sql;
        return { rows: [] };
      }
      if (sql.includes("AND direction = 'outbound'")) return { rows: [] };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    });

    const pairs = await fetchResponsePairs({
      orgId: "org-1",
      start: new Date("2026-04-27T04:00:00Z"), // ~midnight ET
      end: new Date("2026-04-27T20:00:00Z"),
      businessHours: false,
    });

    // Both reps' replies should be present.
    expect(pairs.map((p) => p.threadId).sort()).toEqual(["th-A", "th-B"]);
    expect(pairs.every((p) => p.outboundAt !== null)).toBe(true);

    // SQL must use the new lane discriminator and must NOT still gate on
    // linked_account_id IS NOT NULL. Strip SQL comments so the regression
    // assertion isn't fooled by the explanatory comment we left in place.
    const stripComments = (sql: string | null) =>
      (sql ?? "").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    const repliesSql = stripComments(repliesSqlCaptured);
    const inboundsSql = stripComments(inboundsSqlCaptured);
    expect(repliesSql).toContain("em.linked_outreach_log_id IS NULL");
    expect(repliesSql).not.toMatch(/em\.linked_account_id\)\s*IS NOT NULL/);
    expect(inboundsSql).toContain("inb.linked_outreach_log_id IS NULL");
    expect(inboundsSql).not.toMatch(/inb\.linked_account_id\)\s*IS NOT NULL/);
  });

  it("keeps the thread in waiting when there is no post-inbound outbound at all", async () => {
    setupMocks({
      users: [],
      mailboxes: [],
      replies: [],
      latestInbounds: [
        {
          row_id: "in-2",
          thread_id: "th-B",
          org_id: "org-1",
          inbound_at: "2026-04-15T14:00:00Z",
          from_email: "customer@acct.example",
          subject: "still hanging",
          account_id: "acct-Y",
          owner_user_id: null,
          owner_name: null,
          account_name: "Acct Y",
        },
      ],
      outbounds: [
        // Pre-inbound outbound — must NOT clear the wait.
        {
          thread_id: "th-B",
          from_email: "alice@acme.com",
          outbound_at: "2026-04-15T13:00:00Z",
        },
      ],
    });

    const pairs = await fetchResponsePairs({
      orgId: "org-1",
      start: new Date("2026-04-15T00:00:00Z"),
      end: new Date("2026-04-16T00:00:00Z"),
      businessHours: false,
    });

    expect(pairs.length).toBe(1);
    expect(pairs[0].outboundAt).toBeNull(); // still waiting
    expect(pairs[0].threadId).toBe("th-B");
  });
});
