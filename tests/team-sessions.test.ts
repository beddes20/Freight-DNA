/**
 * Deterministic API-level tests for GET /api/1on1/team-sessions (Director View)
 *
 * Run with: npx tsx tests/team-sessions.test.ts
 *
 * Creates isolated test fixtures in the existing organization, verifies endpoint
 * behavior against all acceptance criteria, and cleans up afterwards.
 */

import pg from "pg";
import crypto from "crypto";
import bcrypt from "bcrypt";
import http from "http";

const SERVER_HOST = "localhost";
const SERVER_PORT = 5000;

/** Make an HTTP request using Node's http module with Connection: close. */
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
          ...(options.body
            ? { "Content-Length": Buffer.byteLength(options.body).toString() }
            : {}),
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

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

// Track created records in reverse-insertion order for safe cleanup
const cleanupIds: { table: string; id: string }[] = [];

function uid(): string {
  return crypto.randomUUID();
}

async function q(text: string, values?: unknown[]): Promise<pg.QueryResult> {
  return pool.query(text, values);
}

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
  const body = JSON.stringify({ username, password });
  const res = await httpRequest({
    method: "POST",
    path: "/api/auth/login",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (res.status !== 200) {
    throw new Error(`Login failed for ${username}: ${res.status} ${res.body}`);
  }
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find(c => c.startsWith("connect.sid"))?.split(";")[0];
  if (!sessionCookie) throw new Error(`No session cookie returned for ${username}`);
  return sessionCookie;
}

async function apiGet(
  path: string,
  cookie: string
): Promise<{ status: number; json: unknown }> {
  const res = await httpRequest({
    method: "GET",
    path,
    headers: { Cookie: cookie },
  });
  const json: unknown = JSON.parse(res.body);
  return { status: res.status, json };
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

async function createUser(
  orgId: string,
  role: string,
  managerId?: string
): Promise<{ id: string; username: string; password: string }> {
  const id = uid();
  const password = `Pass${id.slice(0, 8)}!`;
  const hash = await bcrypt.hash(password, 10);
  const username = `test.${id.slice(0, 8)}@example.com`;
  const now = new Date().toISOString();
  await q(
    `INSERT INTO users (id, organization_id, username, password, name, role, manager_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, orgId, username, hash, `TestUser ${id.slice(0, 6)}`, role, managerId ?? null, now]
  );
  cleanupIds.unshift({ table: "users", id });
  return { id, username, password };
}

async function createSession(namId: string, amId: string): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO one_on_one_sessions (id, nam_id, am_id, status, start_date, morale_score)
     VALUES ($1, $2, $3, 'active', $4, 4)`,
    [id, namId, amId, now.slice(0, 10)]
  );
  cleanupIds.unshift({ table: "one_on_one_sessions", id });
  return id;
}

async function createTopic(
  sessionId: string,
  addedById: string,
  text: string
): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO one_on_one_topics (id, session_id, added_by_id, text, tag, status, created_at)
     VALUES ($1, $2, $3, $4, 'action_item', 'pending', $5)`,
    [id, sessionId, addedById, text, now]
  );
  cleanupIds.unshift({ table: "one_on_one_topics", id });
  return id;
}

async function createReply(
  topicId: string,
  authorId: string,
  text: string
): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO one_on_one_topic_replies (id, topic_id, author_id, text, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, topicId, authorId, text, now]
  );
  cleanupIds.unshift({ table: "one_on_one_topic_replies", id });
  return id;
}

async function cleanup(): Promise<void> {
  const order = [
    "one_on_one_topic_replies",
    "one_on_one_topics",
    "one_on_one_sessions",
    "users",
  ];
  for (const table of order) {
    const ids = cleanupIds.filter(c => c.table === table).map(c => c.id);
    for (const id of ids) {
      await q(`DELETE FROM ${table} WHERE id = $1`, [id]).catch(() => {});
    }
  }
}

// ─── Main test runner ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\nTeam Sessions API Tests (/api/1on1/team-sessions)\n");

  const orgId = await getDefaultOrgId();

  // Build test hierarchy: director → nam → am (all in same org)
  // Admin user with no explicit hierarchy — sees all sessions in org
  // Separate unlinked pair: unlinkedNam + unlinkedAm (no connection to director)
  const director = await createUser(orgId, "director");
  const adminUser = await createUser(orgId, "admin");
  const nam = await createUser(orgId, "national_account_manager", director.id);
  const am = await createUser(orgId, "account_manager", nam.id);
  const unlinkedNam = await createUser(orgId, "national_account_manager"); // no manager
  const unlinkedAm = await createUser(orgId, "account_manager", unlinkedNam.id);

  // Sessions
  const inTreeSessionId = await createSession(nam.id, am.id);
  const topicId = await createTopic(inTreeSessionId, nam.id, "Q2 target discussion");
  await createReply(topicId, am.id, "Sounds good, let's review numbers");
  const unlinkedSessionId = await createSession(unlinkedNam.id, unlinkedAm.id);

  // ── Test 1: Unauthenticated → 401 ────────────────────────────────────────
  await runTest("Unauthenticated request returns 401", async () => {
    const res = await httpRequest({ method: "GET", path: "/api/1on1/team-sessions" });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  // ── Test 2: Non-director (AM) → 403 ────────────────────────────────────
  await runTest("Non-director (account_manager) receives 403", async () => {
    const cookie = await loginAs(am.username, am.password);
    const res = await apiGet("/api/1on1/team-sessions", cookie);
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  // ── Test 3: Non-director (NAM) → 403 ───────────────────────────────────
  await runTest("Non-director (national_account_manager) receives 403", async () => {
    const cookie = await loginAs(nam.username, nam.password);
    const res = await apiGet("/api/1on1/team-sessions", cookie);
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  // ── Test 4: Admin role → 200 with session records ────────────────────────
  await runTest("Admin role receives 200 and sees session records", async () => {
    const cookie = await loginAs(adminUser.username, adminUser.password);
    const res = await apiGet("/api/1on1/team-sessions", cookie);
    assert(res.status === 200, `Expected 200 for admin, got ${res.status}`);
    const data = res.json as unknown[];
    assert(Array.isArray(data), "Response for admin should be an array");
  });

  // ── Test 5: Director → 200 with correct shape ───────────────────────────
  await runTest("Director receives 200 with session array of correct shape", async () => {
    const cookie = await loginAs(director.username, director.password);
    const res = await apiGet("/api/1on1/team-sessions", cookie);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const data = res.json as unknown[];
    assert(Array.isArray(data), "Response body should be an array");
    const records = data as Array<Record<string, unknown>>;
    const found = records.find(
      r => (r.session as Record<string, string>)?.id === inTreeSessionId
    );
    assert(found !== undefined, "Expected the in-tree session to appear in response");
    assert("session" in found, "Record should have 'session' field");
    assert("namUser" in found, "Record should have 'namUser' field");
    assert("amUser" in found, "Record should have 'amUser' field");
    assert("topics" in found, "Record should have 'topics' field");
    assert(Array.isArray(found.topics), "'topics' should be an array");
  });

  // ── Test 5: Topics and replies are included ─────────────────────────────
  await runTest("Director sees topics and replies for subordinate sessions", async () => {
    const cookie = await loginAs(director.username, director.password);
    const res = await apiGet("/api/1on1/team-sessions", cookie);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const data = res.json as Array<{
      session: { id: string };
      topics: Array<{ text: string; replies: Array<{ text: string }> }>;
    }>;
    const found = data.find(r => r.session.id === inTreeSessionId);
    assert(found !== undefined, "Expected in-tree session in response");
    assert(found.topics.length > 0, "Session should include topics");
    assert(found.topics[0].text === "Q2 target discussion", "Topic text should match");
    assert(found.topics[0].replies.length > 0, "Topic should include replies");
    assert(
      found.topics[0].replies[0].text === "Sounds good, let's review numbers",
      "Reply text should match"
    );
  });

  // ── Test 6: Morale score is excluded ────────────────────────────────────
  await runTest("Morale score is excluded from all session records in director view", async () => {
    const cookie = await loginAs(director.username, director.password);
    const res = await apiGet("/api/1on1/team-sessions", cookie);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const data = res.json as Array<{ session: Record<string, unknown> }>;
    for (const record of data) {
      assert(
        record.session.moraleScore === undefined || record.session.moraleScore === null,
        `moraleScore should be stripped, but found: ${record.session.moraleScore}`
      );
    }
  });

  // ── Test 7: Hierarchy boundary — out-of-tree sessions NOT included ───────
  await runTest("Director does NOT see sessions outside their hierarchy", async () => {
    const cookie = await loginAs(director.username, director.password);
    const res = await apiGet("/api/1on1/team-sessions", cookie);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const data = res.json as Array<{ session: { id: string } }>;
    const hasOutside = data.some(r => r.session.id === unlinkedSessionId);
    assert(
      !hasOutside,
      `Director should NOT see unlinked session ${unlinkedSessionId}`
    );
  });

  // ── Test 8: managerId change is reflected in next call ──────────────────
  await runTest("Hierarchy update (manager_id change) is reflected immediately", async () => {
    const cookie = await loginAs(director.username, director.password);

    // Before: unlinkedNam has no managerId → unlinkedSession should not appear
    const resBefore = await apiGet("/api/1on1/team-sessions", cookie);
    assert(
      resBefore.status === 200,
      `Expected 200 before update, got ${resBefore.status}`
    );
    const before = resBefore.json as Array<{ session: { id: string } }>;
    assert(
      !before.some(r => r.session.id === unlinkedSessionId),
      "Unlinked session should NOT be visible before manager_id update"
    );

    // Link unlinkedNam to director (simulate manager reassignment)
    await q(`UPDATE users SET manager_id = $1 WHERE id = $2`, [director.id, unlinkedNam.id]);

    // After: unlinkedNam is now a direct subordinate → unlinkedSession should appear
    const resAfter = await apiGet("/api/1on1/team-sessions", cookie);
    assert(
      resAfter.status === 200,
      `Expected 200 after update, got ${resAfter.status}`
    );
    const after = resAfter.json as Array<{ session: { id: string } }>;
    assert(
      after.some(r => r.session.id === unlinkedSessionId),
      "Unlinked session SHOULD be visible after manager_id points to director"
    );

    // Reset to avoid polluting other tests
    await q(`UPDATE users SET manager_id = NULL WHERE id = $1`, [unlinkedNam.id]);
  });

  // ─── Cleanup & summary ───────────────────────────────────────────────────
  await cleanup();
  await pool.end();

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${results.length} tests\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(async (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Test runner error:", msg);
  await cleanup();
  await pool.end().catch(() => {});
  process.exit(1);
});
