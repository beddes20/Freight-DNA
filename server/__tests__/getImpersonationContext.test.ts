/**
 * Task #972 — `getImpersonationContext(req)` runtime behavior.
 *
 * The Available Freight cockpit (and `/api/auth/me`) read the same helper
 * to decide "is this request happening under an admin's view-as session?"
 * and "if so, who is being viewed?". A mistake in this helper would
 * silently break the cockpit's base-scope guarantee, so we cover all
 * three branches with real runtime invocations (mocking only Clerk's
 * `getAuth` + the `impersonationMap`'s entrypoint, never the helper
 * itself).
 *
 * Branches under test:
 *   1. Clerk-mode admin with a live impersonation map entry → impersonating.
 *   2. Clerk-mode signed-in user with NO impersonation entry → not impersonating.
 *   3. Dev session-mode (no Clerk userId, but `req.session.impersonatingAdminId`
 *      is set) → impersonating, with `impersonatedUserId` taken from
 *      `req.session.userId`.
 *   4. Anonymous request (no Clerk userId, no session impersonation) →
 *      not impersonating.
 *   5. After `/api/admin/impersonate/stop` clears the map → not impersonating.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Configurable Clerk getAuth — every test sets this before invoking the
// helper. Default: anonymous (no Clerk userId).
let clerkAuthImpl: () => { userId: string | null } = () => ({ userId: null });

vi.mock("@clerk/express", () => ({
  getAuth: () => clerkAuthImpl(),
  // The auth.ts module imports these at module load — stub so the import
  // resolves without a real Clerk instance.
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
  clerkClient: { users: { getUser: async () => null } },
  verifyToken: async () => ({ sub: null }),
}));

// auth.ts imports storage + the unprovisioned-signin notifier at module
// load. Neither is exercised by `getImpersonationContext`, but the
// imports must resolve cleanly under vitest.
vi.mock("../storage", () => ({
  storage: {
    getUser: async () => null,
    getUserByClerkId: async () => null,
    getUserByUsername: async () => null,
    updateUser: async () => null,
  },
}));
vi.mock("../unprovisionedSignInNotifications", () => ({
  notifyAdminsOfUnprovisionedSignIn: async () => {},
}));

// Connect-pg-simple opens a Postgres pool at construct time; stub it
// with an EventEmitter-derived store so express-session's `store.on`
// wiring loads without a database.
vi.mock("connect-pg-simple", async () => {
  const { EventEmitter } = await import("events");
  return {
    default: () => class FakeStore extends EventEmitter {
      get() { /* noop */ }
      set() { /* noop */ }
      destroy() { /* noop */ }
    },
  };
});

// Imported AFTER mocks so the helper sees our stubbed `getAuth`.
import { getImpersonationContext, setupAuth } from "../auth";

// `impersonationMap` is module-private. The only way to mutate it from
// the outside is to drive the admin-impersonate endpoints, which is
// exactly what production code does too. We construct a tiny Express
// app with `setupAuth`, then exercise the endpoints via the registered
// handlers (no HTTP listener needed).
import express from "express";

function makeReq(opts: {
  clerkUserId?: string | null;
  sessionUserId?: string | null;
  sessionAdminId?: string | null;
}): any {
  // Set the Clerk getAuth impl for THIS request (the helper reads it
  // synchronously inside the function call).
  clerkAuthImpl = () => ({ userId: opts.clerkUserId ?? null });
  return {
    session: {
      userId: opts.sessionUserId ?? undefined,
      impersonatingAdminId: opts.sessionAdminId ?? undefined,
    },
  };
}

describe("Task #972 — getImpersonationContext", () => {
  beforeEach(() => {
    clerkAuthImpl = () => ({ userId: null });
  });

  it("returns not-impersonating for an anonymous request (no Clerk, no session)", () => {
    const req = makeReq({});
    const ctx = getImpersonationContext(req);
    expect(ctx).toEqual({
      isImpersonating: false,
      impersonatedUserId: null,
      adminId: null,
    });
  });

  it("returns not-impersonating for a Clerk-signed-in user with no impersonation map entry", () => {
    const req = makeReq({ clerkUserId: "clerk_admin_123" });
    const ctx = getImpersonationContext(req);
    expect(ctx).toEqual({
      isImpersonating: false,
      impersonatedUserId: null,
      adminId: null,
    });
  });

  it("returns impersonating with the dev-session admin id when req.session.impersonatingAdminId is set", () => {
    // No Clerk userId → falls through to the dev-session branch.
    const req = makeReq({
      clerkUserId: null,
      sessionUserId: "user_rep_target",
      sessionAdminId: "user_admin_acting",
    });
    const ctx = getImpersonationContext(req);
    expect(ctx).toEqual({
      isImpersonating: true,
      impersonatedUserId: "user_rep_target",
      adminId: "user_admin_acting",
    });
  });

  it("does NOT report impersonation when only req.session.userId is set (no admin id)", () => {
    // A normal dev-session login (no impersonation) sets userId but
    // never sets impersonatingAdminId — must NOT trigger the
    // viewing-as branch.
    const req = makeReq({
      clerkUserId: null,
      sessionUserId: "user_normal_login",
      sessionAdminId: null,
    });
    const ctx = getImpersonationContext(req);
    expect(ctx).toEqual({
      isImpersonating: false,
      impersonatedUserId: null,
      adminId: null,
    });
  });

  it("returns impersonating for a Clerk admin with a live impersonation map entry, then stops after the entry is cleared", async () => {
    // Drive the real `/api/admin/impersonate/:userId` and `/stop`
    // endpoints to mutate the module-private `impersonationMap`.
    const adminClerkId = "clerk_admin_view_as";
    const targetDbId = "db_user_rep_being_viewed";

    // 1) Register the admin endpoints on a throwaway Express app.
    const app = express();
    app.use(express.json());
    // setupAuth wires session middleware + Clerk middleware + the
    // /api/admin/impersonate endpoints onto the app.
    setupAuth(app);

    // 2) Find the start + stop handlers from the registered routes so
    //    we can invoke them directly without an HTTP listener.
    type Layer = { route?: { path: string; stack: Array<{ handle: Function }> } };
    // Express 4 exposes `_router`; Express 5 renamed it to `router`. Try both.
    const router = (app as any)._router ?? (app as any).router;
    if (!router?.stack) throw new Error("Express router stack not exposed for introspection");
    const layers = router.stack as Layer[];
    const findHandler = (path: string) => {
      const layer = layers.find(l => l.route?.path === path);
      if (!layer?.route) throw new Error(`route ${path} not registered`);
      // Last middleware in the stack is the actual handler.
      return layer.route.stack[layer.route.stack.length - 1].handle;
    };

    // The start endpoint is `/api/admin/impersonate/:userId`. We need
    // the admin to look like a real admin to Clerk + storage. We mock
    // both ends:
    //   - getAuth returns the admin's Clerk id
    //   - storage stubs already return null, so we patch
    //     `storage.getUser` for THIS test to return an admin record
    //     for the admin's DB-side user, plus the target rep.
    const storageMod = await import("../storage");
    const dbAdmin = { id: "db_admin_acting", role: "admin", organizationId: "org_x" };
    const dbTarget = { id: targetDbId, role: "rep", organizationId: "org_x" };
    (storageMod.storage as any).getUser = async (id: string) => {
      if (id === dbAdmin.id) return dbAdmin;
      if (id === dbTarget.id) return dbTarget;
      return null;
    };
    (storageMod.storage as any).getUserByClerkId = async (cid: string) =>
      cid === adminClerkId ? dbAdmin : null;

    // 3) Invoke the start handler.
    clerkAuthImpl = () => ({ userId: adminClerkId });
    const startHandler = findHandler("/api/admin/impersonate/:userId");
    const startRes = {
      _status: 200,
      _body: null as any,
      status(code: number) { this._status = code; return this; },
      json(payload: any) { this._body = payload; return this; },
    };
    await startHandler(
      { params: { userId: targetDbId }, session: {}, body: {} },
      startRes,
      () => {},
    );
    expect(startRes._status, JSON.stringify(startRes._body)).toBe(200);

    // 4) Now `getImpersonationContext` for a request from the same
    //    Clerk admin must report impersonation of the target.
    const reqDuring = makeReq({ clerkUserId: adminClerkId });
    const ctxDuring = getImpersonationContext(reqDuring);
    expect(ctxDuring).toEqual({
      isImpersonating: true,
      impersonatedUserId: targetDbId,
      adminId: adminClerkId,
    });

    // 5) Stop impersonation and re-check. Endpoint is
    //    `/api/admin/stop-impersonating` (Clerk-mode reads
    //    `impersonationMap` via the same admin clerk id we set above).
    const stopHandler = findHandler("/api/admin/stop-impersonating");
    const stopRes = {
      _status: 200,
      _body: null as any,
      status(code: number) { this._status = code; return this; },
      json(payload: any) { this._body = payload; return this; },
    };
    clerkAuthImpl = () => ({ userId: adminClerkId });
    await stopHandler({ session: {} }, stopRes, () => {});
    expect(stopRes._status).toBe(200);

    const reqAfter = makeReq({ clerkUserId: adminClerkId });
    const ctxAfter = getImpersonationContext(reqAfter);
    expect(ctxAfter).toEqual({
      isImpersonating: false,
      impersonatedUserId: null,
      adminId: null,
    });
  });
});
