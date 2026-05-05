/**
 * Task #1060 — Team Performance access regression test.
 *
 * Verifies that:
 *   1. /api/team/performance no longer 403s for account_manager,
 *      logistics_manager, or logistics_coordinator (the legacy gated roles).
 *   2. Calling without `scope=all` returns only the caller's reporting tree
 *      (self + transitive direct reports + same-manager peers) for non-admins.
 *   3. Calling with `scope=all` returns the same org-wide rep id-set the
 *      admin path produces.
 *   4. The sidebar nav entry for Team Performance has no role restriction
 *      so it is visible for all roles (guards against future role-list edits
 *      silently re-closing the tab).
 *
 * Run with: npx tsx tests/team-performance-access.test.ts
 */

import pg from "pg";
import crypto from "crypto";
import bcrypt from "bcrypt";
import http from "http";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SERVER_HOST = "localhost";
const SERVER_PORT = 5000;

function httpRequest(options: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: Record<string, string | string[]>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: SERVER_HOST,
        port: SERVER_PORT,
        path: options.path,
        method: options.method,
        headers: {
          Connection: "close",
          ...options.headers,
          ...(options.body ? { "Content-Length": Buffer.byteLength(options.body).toString() } : {}),
        },
      },
      res => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => {
          const headers: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) headers[k.toLowerCase()] = v;
          }
          resolve({ status: res.statusCode ?? 0, headers, body: data });
        });
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const cleanupIds: { table: string; id: string }[] = [];

function uid(): string {
  return crypto.randomUUID();
}

async function q(text: string, values?: unknown[]): Promise<pg.QueryResult> {
  return pool.query(text, values);
}

interface TestResult { name: string; passed: boolean; error?: string; }
const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`  ✓ ${name}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error: message });
    console.log(`  ✗ ${name}: ${message}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function getDefaultOrgId(): Promise<string> {
  const res = await q("SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1");
  if (res.rows.length === 0) throw new Error("No organizations found in database");
  return res.rows[0].id as string;
}

async function loginAs(username: string, password: string): Promise<string> {
  const res = await httpRequest({
    method: "POST",
    path: "/api/auth/login",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) throw new Error(`Login failed for ${username}: ${res.status} ${res.body}`);
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find(c => c.startsWith("connect.sid"))?.split(";")[0];
  if (!sessionCookie) throw new Error(`No session cookie returned for ${username}`);
  return sessionCookie;
}

async function apiGet(p: string, cookie: string): Promise<{ status: number; json: unknown; body: string }> {
  const res = await httpRequest({ method: "GET", path: p, headers: { Cookie: cookie } });
  let json: unknown = null;
  try { json = JSON.parse(res.body); } catch { /* not json */ }
  return { status: res.status, json, body: res.body };
}

async function createUser(orgId: string, role: string, managerId?: string): Promise<{ id: string; username: string; password: string }> {
  const id = uid();
  const password = `Pass${id.slice(0, 8)}!`;
  const hash = await bcrypt.hash(password, 10);
  const username = `t1060.${id.slice(0, 8)}@example.com`;
  const now = new Date().toISOString();
  await q(
    `INSERT INTO users (id, organization_id, username, password, name, role, manager_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, orgId, username, hash, `T1060 ${id.slice(0, 6)}`, role, managerId ?? null, now]
  );
  cleanupIds.unshift({ table: "users", id });
  return { id, username, password };
}

async function cleanup(): Promise<void> {
  const ids = cleanupIds.filter(c => c.table === "users").map(c => c.id);
  for (const id of ids) {
    await q(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
  }
}

function repIds(json: unknown): string[] {
  if (Array.isArray(json)) return (json as Array<{ userId: string }>).map(r => r.userId);
  if (json && typeof json === "object" && Array.isArray((json as { reps?: unknown }).reps)) {
    return ((json as { reps: Array<{ userId: string }> }).reps).map(r => r.userId);
  }
  return [];
}

async function findAdminUsername(orgId: string): Promise<{ username: string; password: string } | null> {
  // Use existing admin if a known dev seed login exists; otherwise return null
  // and we will create a synthetic admin for the test (cleaned up at end).
  const _ = orgId;
  return null;
}

async function main(): Promise<void> {
  console.log("\nTeam Performance Access Tests (Task #1060)\n");

  // ── Static check: nav entry has no role restriction ────────────────────────
  await runTest("nav-items.ts has no role gating on Team Performance entry", async () => {
    const navSrc = fs.readFileSync(path.join(ROOT, "client/src/lib/nav-items.ts"), "utf-8");
    // Find the Team Performance entry block.
    const idx = navSrc.indexOf("Team Performance");
    assert(idx > 0, "Team Performance entry not found in nav-items.ts");
    // The object literal closes at the first `},` after the title. Examine it.
    const closeIdx = navSrc.indexOf("},", idx);
    assert(closeIdx > idx, "Could not locate Team Performance entry close brace");
    const block = navSrc.slice(idx, closeIdx);
    assert(
      !/\broles\s*:/.test(block),
      `Team Performance nav entry must not have a roles: restriction (Task #1060). Block:\n${block}`
    );
  });

  // ── Static check: server route does not 403 the legacy gated roles ─────────
  await runTest("/api/team/performance handler removed amEquivRoles 403 block", async () => {
    const routesSrc = fs.readFileSync(path.join(ROOT, "server/routes.ts"), "utf-8");
    const handlerStart = routesSrc.indexOf('app.get("/api/team/performance"');
    assert(handlerStart > 0, "Handler not found");
    // Examine the first ~3500 characters of the handler.
    const handlerSlice = routesSrc.slice(handlerStart, handlerStart + 3500);
    assert(
      !/amEquivRoles\.includes\(user\.role\)\s*\)\s*return\s+res\.status\(403\)/.test(handlerSlice),
      "Legacy `amEquivRoles 403` block must be removed from /api/team/performance"
    );
    assert(
      /scope/.test(handlerSlice),
      "/api/team/performance must read req.query.scope"
    );
  });

  // ── Live API checks ────────────────────────────────────────────────────────
  const orgId = await getDefaultOrgId();

  // Hierarchy: nam (manager) → am (rep), plus a peer am under same manager.
  const nam = await createUser(orgId, "national_account_manager");
  const am = await createUser(orgId, "account_manager", nam.id);
  const peerAm = await createUser(orgId, "account_manager", nam.id);
  const lm = await createUser(orgId, "logistics_manager", nam.id);
  const lc = await createUser(orgId, "logistics_coordinator", nam.id);
  // Synthetic admin so we have a comparable "all" baseline.
  const admin = await createUser(orgId, "admin");

  const amCookie = await loginAs(am.username, am.password);
  const lmCookie = await loginAs(lm.username, lm.password);
  const lcCookie = await loginAs(lc.username, lc.password);
  const adminCookie = await loginAs(admin.username, admin.password);

  await runTest("AM (formerly 403) gets 200 from /api/team/performance with no scope", async () => {
    const r = await apiGet("/api/team/performance?period=current", amCookie);
    assert(r.status === 200, `expected 200, got ${r.status} body=${r.body.slice(0, 200)}`);
  });

  await runTest("LM (formerly 403) gets 200 from /api/team/performance with no scope", async () => {
    const r = await apiGet("/api/team/performance?period=current", lmCookie);
    assert(r.status === 200, `expected 200, got ${r.status} body=${r.body.slice(0, 200)}`);
  });

  await runTest("LC (formerly 403) gets 200 from /api/team/performance with no scope", async () => {
    const r = await apiGet("/api/team/performance?period=current", lcCookie);
    assert(r.status === 200, `expected 200, got ${r.status} body=${r.body.slice(0, 200)}`);
  });

  await runTest("Default scope (mine) returns only the caller's team for a non-admin", async () => {
    const r = await apiGet("/api/team/performance?period=current", amCookie);
    assert(r.status === 200, `status=${r.status}`);
    const ids = new Set(repIds(r.json));
    // The AM's "team" expansion should include themself + same-manager peers
    // (am, peerAm, lm, lc), and must NOT include the unrelated admin user.
    assert(ids.has(am.id), "expected caller (am) to appear in Mine scope");
    assert(ids.has(peerAm.id), "expected peer am (same manager) to appear in Mine scope");
    assert(!ids.has(admin.id), "Mine scope must not include unrelated admin user");
  });

  await runTest("scope=all returns the same org-wide id-set the admin path produces", async () => {
    const adminAll = await apiGet("/api/team/performance?period=current&scope=all", adminCookie);
    const amAll = await apiGet("/api/team/performance?period=current&scope=all", amCookie);
    assert(adminAll.status === 200 && amAll.status === 200, "both calls must be 200");
    const adminIds = new Set(repIds(adminAll.json));
    const amIds = new Set(repIds(amAll.json));
    // Same set: every id present in admin's view must be present in the AM's
    // explicit All Teams view, and vice-versa.
    for (const id of adminIds) {
      assert(amIds.has(id), `AM scope=all is missing rep id ${id} that admin sees`);
    }
    for (const id of amIds) {
      assert(adminIds.has(id), `AM scope=all has extra rep id ${id} not in admin set`);
    }
    // Both should at least contain the rep-role users we created.
    assert(amIds.has(am.id) && amIds.has(peerAm.id) && amIds.has(lm.id) && amIds.has(lc.id) && amIds.has(nam.id),
      "scope=all must include all rep-role users");
  });
}

main()
  .then(async () => {
    await cleanup();
    await pool.end();
    const failed = results.filter(r => !r.passed);
    console.log(`\nResults: ${results.length - failed.length}/${results.length} passed`);
    if (failed.length) {
      for (const f of failed) console.log(`  ✗ ${f.name}: ${f.error}`);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch(async err => {
    console.error("Test run failed:", err);
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
  });
