/**
 * SSE auth resolver — Task #958.
 *
 * Pins the regression we shipped for the production
 * `live_sync_auth_failure` watchdog: `/api/live-sync/stream` was 401-ing
 * users whose `users.clerk_user_id` had never been linked to a Clerk
 * account, even with a valid token, because `resolveOrgId` looked up
 * users by clerkUserId only — without the email back-fill that
 * `requireAuth → getCurrentUser` performs on every other /api route.
 *
 * The fix extracts a shared `resolveClerkUserToDbUser` helper from
 * `server/auth.ts` and wires the SSE resolver through it. These tests
 * pin that the SSE path:
 *   1. Returns the org when `getUserByClerkId` already finds a row
 *      (steady-state path).
 *   2. **Falls back to email lookup + writes back `clerkUserId`** when
 *      the DB row exists but is unlinked — and returns the resolved
 *      org id afterwards. This is the path that was missing.
 *   3. Returns null when verifyToken throws (and the error is logged,
 *      not silently swallowed).
 *   4. Returns null when no token is supplied.
 *   5. Skips Clerk entirely when an in-process session has already
 *      established `req.session.organizationId`.
 *
 * Strategy: mock `../storage` so we can introspect what the resolver
 * looks up and what it writes back, mock `@clerk/express` so we can
 * pin verifyToken behavior, then exercise `resolveOrgId` directly with
 * a synthetic Express-like Request.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const dbUsers = new Map<string, any>();
const usersByClerkId = new Map<string, any>();
const usersByUsername = new Map<string, any>();
const updateUserCalls: Array<{ id: string; orgId: string; data: any }> = [];

vi.mock("../storage", () => ({
  storage: {
    getUser: async (id: string) => dbUsers.get(id),
    getUserByClerkId: async (clerkUserId: string) => usersByClerkId.get(clerkUserId),
    getUserByUsername: async (username: string) => usersByUsername.get(username),
    updateUser: async (id: string, organizationId: string, data: any) => {
      updateUserCalls.push({ id, orgId: organizationId, data });
      const user = dbUsers.get(id);
      if (user) {
        Object.assign(user, data);
        if (data.clerkUserId) usersByClerkId.set(data.clerkUserId, user);
      }
      return user;
    },
  },
}));

let verifyTokenImpl: (...args: any[]) => Promise<any> = async () => {
  throw new Error("verifyToken not configured for this test");
};
let clerkGetUserImpl: (clerkUserId: string) => Promise<any> = async () => {
  throw new Error("clerkClient.users.getUser not configured for this test");
};

vi.mock("@clerk/express", () => ({
  verifyToken: (...args: any[]) => verifyTokenImpl(...args),
  clerkClient: {
    users: {
      getUser: (clerkUserId: string) => clerkGetUserImpl(clerkUserId),
    },
  },
  // The auth.ts module imports getAuth + clerkMiddleware; we're not
  // exercising those code paths here, but the import has to resolve.
  getAuth: () => ({ userId: null }),
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

// ../services/liveSync is imported by routes/liveSync at module load.
// resolveOrgId itself doesn't touch publish/subscribe, but we still
// need the module to load without a real Postgres connection.
vi.mock("../services/liveSync", () => ({
  subscribe: () => () => {},
  recordLiveSyncAuthOutcome: () => {},
  publish: () => {},
}));

import { resolveOrgId } from "../routes/liveSync";

function makeReq(opts: { token?: string; sessionOrgId?: string }) {
  return {
    query: opts.token ? { token: opts.token } : {},
    session: opts.sessionOrgId ? { organizationId: opts.sessionOrgId } : undefined,
  } as any;
}

beforeEach(() => {
  dbUsers.clear();
  usersByClerkId.clear();
  usersByUsername.clear();
  updateUserCalls.length = 0;
  process.env.CLERK_SECRET_KEY = "sk_test_dummy";
  verifyTokenImpl = async () => ({ sub: "user_clerk_xyz" });
  clerkGetUserImpl = async () => {
    throw new Error("clerk fetch should not be needed in this test");
  };
});

// Task #973 — `resolveOrgId` now returns a structured `ResolveResult`
// rather than the legacy `string | null` so the SSE route can record
// per-user auth metrics + emit a labelled rejection reason. These
// tests assert both the org-id (legacy contract) and the new fields.

describe("resolveOrgId — steady-state path", () => {
  it("returns the org when getUserByClerkId already finds a linked row", async () => {
    const user = {
      id: "db-1",
      organizationId: "org-1",
      clerkUserId: "user_clerk_xyz",
      username: "taylor.cal@valuetruck.com",
    };
    dbUsers.set(user.id, user);
    usersByClerkId.set(user.clerkUserId, user);

    const result = await resolveOrgId(makeReq({ token: "tok" }));
    expect(result.orgId).toBe("org-1");
    expect(result.userId).toBe("db-1");
    expect(result.rejectionReason).toBeNull();
    // Fingerprint is a truncated form of the Clerk user id — short enough
    // for log lines, long enough to correlate.
    expect(result.fingerprint).not.toBe("anon");
    // No back-fill write because the row was already linked.
    expect(updateUserCalls.length).toBe(0);
  });
});

describe("resolveOrgId — email back-fill (the Task #958 regression)", () => {
  it("looks up the user by email and writes back clerkUserId when the DB row is unlinked", async () => {
    const user = {
      id: "db-2",
      organizationId: "org-2",
      clerkUserId: null,
      username: "taylor.cal@valuetruck.com",
    };
    dbUsers.set(user.id, user);
    usersByUsername.set("taylor.cal@valuetruck.com", user);
    // Critical: getUserByClerkId returns nothing — same shape as prod.
    clerkGetUserImpl = async () => ({
      emailAddresses: [{ emailAddress: "Taylor.Cal@ValueTruck.com" }],
    });

    const result = await resolveOrgId(makeReq({ token: "tok" }));

    expect(result.orgId).toBe("org-2");
    expect(result.userId).toBe("db-2");
    expect(result.rejectionReason).toBeNull();
    // The back-fill MUST persist clerkUserId so the next connect
    // takes the cheap getUserByClerkId path.
    expect(updateUserCalls.length).toBe(1);
    expect(updateUserCalls[0]).toEqual({
      id: "db-2",
      orgId: "org-2",
      data: { clerkUserId: "user_clerk_xyz" },
    });
  });

  it("returns no-db-user when neither getUserByClerkId nor email lookup finds a row", async () => {
    clerkGetUserImpl = async () => ({
      emailAddresses: [{ emailAddress: "ghost@nowhere.com" }],
    });
    const result = await resolveOrgId(makeReq({ token: "tok" }));
    expect(result.orgId).toBeNull();
    expect(result.rejectionReason).toBe("no-db-user");
    expect(updateUserCalls.length).toBe(0);
  });
});

describe("resolveOrgId — token failure modes", () => {
  it("returns the labelled verify error and logs (does not throw) when verifyToken throws", async () => {
    verifyTokenImpl = async () => {
      throw new Error("token expired");
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await resolveOrgId(makeReq({ token: "tok" }));
    expect(result.orgId).toBeNull();
    // The structured rejection reason replaces the previous null-only
    // signal so the watchdog can label the auth alert.
    expect(result.rejectionReason).toBe("expired");
    // Cause must be surfaced to logs (was previously silently swallowed,
    // which made the prod regression invisible).
    expect(warnSpy).toHaveBeenCalled();
    const logged = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(logged).toMatch(/live-sync\/auth/);
    expect(logged).toMatch(/token expired/);
    warnSpy.mockRestore();
  });

  it("returns no-token-or-secret when no token is supplied", async () => {
    const result = await resolveOrgId(makeReq({}));
    expect(result.orgId).toBeNull();
    expect(result.rejectionReason).toBe("no-token-or-secret");
  });

  it("returns no-token-or-secret when CLERK_SECRET_KEY is not set, even with a token", async () => {
    delete process.env.CLERK_SECRET_KEY;
    const result = await resolveOrgId(makeReq({ token: "tok" }));
    expect(result.orgId).toBeNull();
    expect(result.rejectionReason).toBe("no-token-or-secret");
  });
});

describe("resolveOrgId — session shortcut", () => {
  it("honours an existing session.organizationId without round-tripping Clerk", async () => {
    verifyTokenImpl = async () => {
      throw new Error("verifyToken should never be called on the session path");
    };
    const result = await resolveOrgId(makeReq({ sessionOrgId: "org-session" }));
    expect(result.orgId).toBe("org-session");
    expect(result.rejectionReason).toBeNull();
  });
});
