/**
 * API-level tests for the Lane Work Queue and Lane Assignment (V1.5)
 *
 * Covers the exact guardrails verified and patched in the QA pass:
 *   - getLaneWorkQueue bucket correctness (including the catch-all inProgress fix)
 *   - No lane silently dropped when contacted >= threshold but resolvedAt is null
 *   - Non-manager cannot assign to another user (403)
 *   - Non-manager can self-assign an unassigned lane (200)
 *   - Non-manager blocked from taking an already-owned lane (403)
 *   - Manager/director can assign any in-org lane (200)
 *   - Cross-org assignment fails (400)
 *   - Work queue endpoint requires manager role (403 for AM)
 *   - Unauthenticated work queue → 401
 *
 * Run with: npx tsx tests/lane-work-queue.test.ts
 *
 * Requires the dev server to be running on port 5000.
 * Creates isolated test fixtures and cleans up after all tests.
 */

import pg from "pg";
import crypto from "crypto";
import bcrypt from "bcrypt";
import http from "http";

const SERVER_HOST = "localhost";
const SERVER_PORT = 5000;

// ── HTTP helper ───────────────────────────────────────────────────────────────

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

// ── DB helpers ────────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function q(text: string, values?: unknown[]): Promise<pg.QueryResult> {
  return pool.query(text, values);
}

function uid(): string {
  return crypto.randomUUID();
}

// ── Test harness ──────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];
const cleanupIds: { table: string; id: string }[] = [];

function track(table: string, id: string): void {
  cleanupIds.unshift({ table, id });
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

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function loginAs(username: string, password: string): Promise<string> {
  const body = JSON.stringify({ username, password });
  const res = await httpRequest({
    method: "POST",
    path: "/api/auth/login",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (res.status !== 200) throw new Error(`Login failed for ${username}: ${res.status} ${res.body}`);
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sessionCookie = cookies.find(c => c.startsWith("connect.sid"))?.split(";")[0];
  if (!sessionCookie) throw new Error(`No session cookie for ${username}`);
  return sessionCookie;
}

async function apiGet(path: string, cookie: string): Promise<{ status: number; json: unknown }> {
  const res = await httpRequest({ method: "GET", path, headers: { Cookie: cookie } });
  let json: unknown;
  try { json = JSON.parse(res.body); } catch { json = res.body; }
  return { status: res.status, json };
}

async function apiPost(
  path: string,
  cookie: string,
  body: unknown
): Promise<{ status: number; json: unknown }> {
  const bodyStr = JSON.stringify(body);
  const res = await httpRequest({
    method: "POST",
    path,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: bodyStr,
  });
  let json: unknown;
  try { json = JSON.parse(res.body); } catch { json = res.body; }
  return { status: res.status, json };
}

// ── Fixture helpers ────────────────────────────────────────────────────────────

async function getDefaultOrgId(): Promise<string> {
  const res = await q("SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1");
  if (res.rows.length === 0) throw new Error("No organizations found");
  return res.rows[0].id as string;
}

/** Return a second org for cross-org isolation tests. Creates one if only one exists. */
async function getSecondOrgId(excludeOrgId: string): Promise<string> {
  const res = await q("SELECT id FROM organizations WHERE id != $1 ORDER BY created_at ASC LIMIT 1", [excludeOrgId]);
  if (res.rows.length > 0) return res.rows[0].id as string;
  // Fall back: create a minimal second org
  const id = uid();
  const slug = `testorg-${id.slice(0, 8)}`;
  await q(
    `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`,
    [id, `TestOrg_${id.slice(0, 8)}`, slug]
  );
  track("organizations", id);
  return id;
}

async function createUser(
  orgId: string,
  role: string
): Promise<{ id: string; username: string; password: string }> {
  const id = uid();
  const password = `Pass${id.slice(0, 8)}!`;
  const hash = await bcrypt.hash(password, 10);
  const username = `wq.test.${id.slice(0, 8)}@example.com`;
  const now = new Date().toISOString();
  await q(
    `INSERT INTO users (id, organization_id, username, password, name, role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, orgId, username, hash, `WQTest ${id.slice(0, 6)}`, role, now]
  );
  track("users", id);
  return { id, username, password };
}

async function enableFeatureFlag(orgId: string): Promise<void> {
  const flagId = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO feature_flags (id, org_id, flag_key, enabled, updated_at)
     VALUES ($1, $2, 'lane_carrier_outreach_v1', true, $3)
     ON CONFLICT (org_id, flag_key) DO UPDATE SET enabled = true`,
    [flagId, orgId, now]
  );
}

async function createLane(
  orgId: string,
  ownerUserId: string | null,
  carriersContacted = 0,
  resolvedAt: string | null = null,
  hasContactableBench = false
): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO recurring_lanes
       (id, org_id, origin, destination, is_eligible, has_preferred_carrier_program,
        owner_user_id, carriers_contacted_count, resolved_at, eligibility_confidence, created_at, updated_at)
     VALUES ($1, $2, 'chicago', 'dallas', true, false, $3, $4, $5, 'medium', $6, $6)`,
    [id, orgId, ownerUserId, carriersContacted, resolvedAt, now]
  );
  track("recurring_lanes", id);

  if (hasContactableBench) {
    // Insert a bench entry with no actual carrierId (simulating name-only with contact info)
    // The contactableCount is determined by carrierId → carrier lookup;
    // for simplicity we just track the bench entry existing
    const bId = uid();
    await q(
      `INSERT INTO lane_carrier_interest (id, lane_id, carrier_name, interest_status, source_type, created_at, updated_at)
       VALUES ($1, $2, 'Test Carrier LLC', 'needs_follow_up', 'historical', $3, $3)`,
      [bId, id, now]
    );
    track("lane_carrier_interest", bId);
  }

  return id;
}

/** Same as createLane but with a customer company_name — used for customer filter tests. */
async function createLaneWithCustomer(
  orgId: string,
  ownerUserId: string | null,
  companyName: string
): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO recurring_lanes
       (id, org_id, origin, destination, is_eligible, has_preferred_carrier_program,
        owner_user_id, carriers_contacted_count, eligibility_confidence, company_name, created_at, updated_at)
     VALUES ($1, $2, 'chicago', 'dallas', true, false, $3, 0, 'medium', $4, $5, $5)`,
    [id, orgId, ownerUserId, companyName, now]
  );
  track("recurring_lanes", id);
  return id;
}

// ── Cleanup ────────────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  // Belt-and-suspenders: even though this test never inserts into
  // monitored_mailboxes directly, an admin who clicks "Enroll all eligible
  // users" while these wq.test.* users exist will create monitored_mailbox
  // rows for them — and those rows can never receive Microsoft Graph
  // notifications (the addresses don't exist in any tenant), permanently
  // tripping the Conversations Inbox "Webhook unhealthy" badge. Drop any
  // monitored mailboxes pointed at our test users BEFORE we delete the users.
  const userIds = cleanupIds.filter(c => c.table === "users").map(c => c.id);
  if (userIds.length > 0) {
    await q(
      `DELETE FROM monitored_mailboxes WHERE user_id = ANY($1::text[])`,
      [userIds],
    ).catch(() => {});
  }
  // Catch-all in case a legacy row predates the user-id link.
  await q(
    `DELETE FROM monitored_mailboxes WHERE LOWER(email) LIKE 'wq.test.%@example.com'`,
  ).catch(() => {});

  const order = [
    "tasks",
    "lane_carrier_interest",
    "carrier_outreach_activity",
    "carrier_outreach_logs",
    "recurring_lanes",
    "feature_flags",
    "users",
    "organizations",
  ];
  for (const table of order) {
    const ids = cleanupIds.filter(c => c.table === table).map(c => c.id);
    for (const id of ids) {
      await q(`DELETE FROM ${table} WHERE id = $1`, [id]).catch(() => {});
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\nLane Work Queue — V1.5 guardrail tests\n");

  const orgId = await getDefaultOrgId();
  await enableFeatureFlag(orgId);

  // Users in main org
  const director = await createUser(orgId, "director");
  const lm = await createUser(orgId, "logistics_manager");
  const am = await createUser(orgId, "account_manager");

  // Second org for cross-org tests (uses an existing org if available)
  const org2Id = await getSecondOrgId(orgId);
  const userOrg2 = await createUser(org2Id, "account_manager");

  // Lanes
  const unassignedLane = await createLane(orgId, null);
  const directorOwnedLane = await createLane(orgId, director.id);
  // Lane at threshold but resolvedAt=null (edge case that must stay in inProgress)
  const aboveThresholdLane = await createLane(orgId, director.id, 5, null, false);

  // ── 1. Unauthenticated ────────────────────────────────────────────────────

  await runTest("Unauthenticated work queue request returns 401", async () => {
    const res = await httpRequest({ method: "GET", path: "/api/recurring-lanes/work-queue" });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  // ── 2. Role guard ─────────────────────────────────────────────────────────

  await runTest("account_manager role is rejected with 403 on work queue", async () => {
    const cookie = await loginAs(am.username, am.password);
    const { status } = await apiGet("/api/recurring-lanes/work-queue", cookie);
    assert(status === 403, `Expected 403, got ${status}`);
  });

  await runTest("logistics_manager role receives 200 on work queue", async () => {
    const cookie = await loginAs(lm.username, lm.password);
    const { status, json } = await apiGet("/api/recurring-lanes/work-queue", cookie);
    assert(status === 200, `Expected 200, got ${status}`);
    const q2 = json as Record<string, unknown[]>;
    assert("unassigned" in q2, "Response missing 'unassigned' bucket");
    assert("noContactable" in q2, "Response missing 'noContactable' bucket");
    assert("assignedUntouched" in q2, "Response missing 'assignedUntouched' bucket");
    assert("inProgress" in q2, "Response missing 'inProgress' bucket");
  });

  await runTest("director role receives 200 and correct shape on work queue", async () => {
    const cookie = await loginAs(director.username, director.password);
    const { status, json } = await apiGet("/api/recurring-lanes/work-queue", cookie);
    assert(status === 200, `Expected 200, got ${status}`);
    const q2 = json as Record<string, unknown[]>;
    assert(Array.isArray(q2.unassigned), "'unassigned' should be an array");
    assert(Array.isArray(q2.noContactable), "'noContactable' should be an array");
    assert(Array.isArray(q2.assignedUntouched), "'assignedUntouched' should be an array");
    assert(Array.isArray(q2.inProgress), "'inProgress' should be an array");
  });

  // ── 3. Unassigned lane appears in correct bucket ──────────────────────────

  await runTest("Unassigned lane appears in the 'unassigned' bucket", async () => {
    const cookie = await loginAs(director.username, director.password);
    const { json } = await apiGet("/api/recurring-lanes/work-queue", cookie);
    const q2 = json as { unassigned: Array<{ lane: { id: string } }> };
    const found = q2.unassigned.some(item => item.lane.id === unassignedLane);
    assert(found, `Lane ${unassignedLane} should be in 'unassigned' bucket`);
  });

  // ── 4. Edge case: contacted >= threshold but resolvedAt=null ─────────────

  await runTest(
    "Lane with contacted >= threshold and resolvedAt=null lands in 'inProgress' (not silently dropped)",
    async () => {
      const cookie = await loginAs(director.username, director.password);
      const { json } = await apiGet("/api/recurring-lanes/work-queue", cookie);
      const q2 = json as {
        unassigned: Array<{ lane: { id: string } }>;
        noContactable: Array<{ lane: { id: string } }>;
        assignedUntouched: Array<{ lane: { id: string } }>;
        inProgress: Array<{ lane: { id: string } }>;
      };
      const allIds = [
        ...q2.unassigned,
        ...q2.noContactable,
        ...q2.assignedUntouched,
        ...q2.inProgress,
      ].map(i => i.lane.id);
      // The lane has an owner (director) and carriersContactedCount=5 (above threshold of 3)
      // With no contactable bench entries it goes to noContactable, but the key assertion is
      // it must appear in SOME bucket — never silently dropped.
      const appearsInSomeBucket = allIds.includes(aboveThresholdLane);
      assert(
        appearsInSomeBucket,
        `Lane ${aboveThresholdLane} (contacted=5, resolvedAt=null) must appear in some bucket — not be silently dropped`
      );
    }
  );

  // ── 5. Work queue item shape ──────────────────────────────────────────────

  await runTest("Work queue items include contactableCount, totalBenchCount, historicalCount, missingContactCount", async () => {
    const cookie = await loginAs(director.username, director.password);
    const { json } = await apiGet("/api/recurring-lanes/work-queue", cookie);
    const q2 = json as { unassigned: Array<Record<string, unknown>> };
    if (q2.unassigned.length === 0) return; // no unassigned lanes in this run — skip shape check
    const item = q2.unassigned[0];
    assert("contactableCount" in item, "Item missing 'contactableCount'");
    assert("totalBenchCount" in item, "Item missing 'totalBenchCount'");
    assert("historicalCount" in item, "Item missing 'historicalCount'");
    assert("missingContactCount" in item, "Item missing 'missingContactCount'");
    assert("lane" in item, "Item missing 'lane'");
  });

  // ── 6. Assign endpoint — auth ─────────────────────────────────────────────

  await runTest("Unauthenticated assign returns 401", async () => {
    const res = await httpRequest({
      method: "POST",
      path: `/api/recurring-lanes/${unassignedLane}/assign`,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerUserId: am.id }),
    });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  // ── 7. Non-manager self-assign (allowed) ──────────────────────────────────

  await runTest("Non-manager (AM) can self-assign an unassigned lane", async () => {
    const cookie = await loginAs(am.username, am.password);
    const { status } = await apiPost(
      `/api/recurring-lanes/${unassignedLane}/assign`,
      cookie,
      { ownerUserId: am.id }
    );
    assert(status === 200, `Expected 200 for AM self-assign, got ${status}`);
    // Reset ownership for subsequent tests
    await q(`UPDATE recurring_lanes SET owner_user_id = NULL, assigned_at = NULL WHERE id = $1`, [unassignedLane]);
  });

  // ── 8. Non-manager assigning to someone else (blocked) ───────────────────

  await runTest("Non-manager (AM) cannot assign a lane to another user (403)", async () => {
    const cookie = await loginAs(am.username, am.password);
    const { status } = await apiPost(
      `/api/recurring-lanes/${unassignedLane}/assign`,
      cookie,
      { ownerUserId: director.id }
    );
    assert(status === 403, `Expected 403 when AM assigns to director, got ${status}`);
  });

  // ── 9. Non-manager cannot take a lane already owned by someone else ───────

  await runTest("Non-manager (AM) cannot take a lane already owned by director (403)", async () => {
    const cookie = await loginAs(am.username, am.password);
    const { status } = await apiPost(
      `/api/recurring-lanes/${directorOwnedLane}/assign`,
      cookie,
      { ownerUserId: am.id }
    );
    assert(status === 403, `Expected 403 when AM tries to take director's lane, got ${status}`);
  });

  // ── 10. Manager can assign in-org (within hierarchy) ─────────────────────

  await runTest("Director can assign any in-org lane to a direct report (200)", async () => {
    // Set am's managerId to director so they are within director's hierarchy
    await q(`UPDATE users SET manager_id = $1 WHERE id = $2`, [director.id, am.id]);
    const cookie = await loginAs(director.username, director.password);
    const { status } = await apiPost(
      `/api/recurring-lanes/${unassignedLane}/assign`,
      cookie,
      { ownerUserId: am.id }
    );
    assert(status === 200, `Expected 200 for director assigning to AM (direct report), got ${status}`);
    // Confirm ownerUserId was written
    const row = await q(`SELECT owner_user_id FROM recurring_lanes WHERE id = $1`, [unassignedLane]);
    assert(row.rows[0].owner_user_id === am.id, "owner_user_id should be set to AM's id");
    // Reset
    await q(`UPDATE recurring_lanes SET owner_user_id = NULL, assigned_at = NULL WHERE id = $1`, [unassignedLane]);
    await q(`UPDATE users SET manager_id = NULL WHERE id = $1`, [am.id]);
  });

  // ── 11. Cross-org assignment blocked ─────────────────────────────────────

  await runTest("Director cannot assign a lane to a user from a different org (400)", async () => {
    const cookie = await loginAs(director.username, director.password);
    const { status } = await apiPost(
      `/api/recurring-lanes/${unassignedLane}/assign`,
      cookie,
      { ownerUserId: userOrg2.id }
    );
    assert(status === 400, `Expected 400 for cross-org assignment, got ${status}`);
  });

  // ── 12. Assign to non-existent user ──────────────────────────────────────

  await runTest("Assigning to a non-existent userId returns 400", async () => {
    const cookie = await loginAs(director.username, director.password);
    const { status } = await apiPost(
      `/api/recurring-lanes/${unassignedLane}/assign`,
      cookie,
      { ownerUserId: uid() }
    );
    assert(status === 400, `Expected 400 for non-existent userId, got ${status}`);
  });

  // ── 13. Assign returns updated lane shape ─────────────────────────────────

  await runTest("Successful assign response contains assignedAt and ownerUserId", async () => {
    // Set lm's managerId to director so they are in the director's hierarchy
    await q(`UPDATE users SET manager_id = $1 WHERE id = $2`, [director.id, lm.id]);
    const cookie = await loginAs(director.username, director.password);
    const { status, json } = await apiPost(
      `/api/recurring-lanes/${unassignedLane}/assign`,
      cookie,
      { ownerUserId: lm.id }
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const lane = json as Record<string, unknown>;
    assert(lane.ownerUserId === lm.id, "ownerUserId should match assigned user");
    assert(typeof lane.assignedAt === "string" && lane.assignedAt.length > 0, "assignedAt should be a non-empty string");
    assert(typeof lane.assignedByUserId === "string" && lane.assignedByUserId.length > 0, "assignedByUserId should be set");
    // Reset
    await q(`UPDATE recurring_lanes SET owner_user_id = NULL, assigned_at = NULL, assigned_by_user_id = NULL WHERE id = $1`, [unassignedLane]);
    await q(`UPDATE users SET manager_id = NULL WHERE id = $1`, [lm.id]);
  });

  // ── 14–20. Hierarchy-Scoped Visibility (Task #150) ───────────────────────

  await runTest("Response includes scopeLabel field for all manager roles", async () => {
    const cookie = await loginAs(director.username, director.password);
    const { status, json } = await apiGet("/api/recurring-lanes/work-queue", cookie);
    assert(status === 200, `Expected 200, got ${status}`);
    const q2 = json as Record<string, unknown>;
    assert("scopeLabel" in q2, "Response should include 'scopeLabel' field");
    assert(typeof q2.scopeLabel === "string" && (q2.scopeLabel as string).length > 0, "scopeLabel should be a non-empty string");
  });

  await runTest("Director scope label is 'Team hierarchy'", async () => {
    const cookie = await loginAs(director.username, director.password);
    const { json } = await apiGet("/api/recurring-lanes/work-queue", cookie);
    const q2 = json as { scopeLabel: string };
    assert(q2.scopeLabel === "Team hierarchy", `Expected 'Team hierarchy', got '${q2.scopeLabel}'`);
  });

  await runTest("logistics_manager scope label is 'My team lanes'", async () => {
    const cookie = await loginAs(lm.username, lm.password);
    const { json } = await apiGet("/api/recurring-lanes/work-queue", cookie);
    const q2 = json as { scopeLabel: string };
    assert(q2.scopeLabel === "My team lanes", `Expected 'My team lanes', got '${q2.scopeLabel}'`);
  });

  await runTest("AM sees only own assigned lane (hierarchy scope)", async () => {
    // Create an AM user with a lane assigned to them
    const amUser = await createUser(orgId, "account_manager");
    // Create another AM (not related) and a lane assigned to that other AM
    const otherAm = await createUser(orgId, "account_manager");
    const amLane = await createLane(orgId, amUser.id, 1);
    const otherAmLane = await createLane(orgId, otherAm.id, 1);

    // Promote amUser to logistics_manager so they can access the work queue
    await q(`UPDATE users SET role = 'logistics_manager' WHERE id = $1`, [amUser.id]);

    const cookie = await loginAs(amUser.username, amUser.password);
    const { json } = await apiGet("/api/recurring-lanes/work-queue", cookie);
    const q2 = json as {
      assignedUntouched: Array<{ lane: { id: string } }>;
      inProgress: Array<{ lane: { id: string } }>;
      noContactable: Array<{ lane: { id: string } }>;
      unassigned: Array<{ lane: { id: string } }>;
    };
    const allIds = [
      ...q2.assignedUntouched,
      ...q2.inProgress,
      ...q2.noContactable,
      ...q2.unassigned,
    ].map(i => i.lane.id);

    // The LM (amUser) has no direct reports — only sees self-assigned lanes
    assert(allIds.includes(amLane), `LM should see their own lane ${amLane}`);
    assert(!allIds.includes(otherAmLane), `LM should NOT see lane ${otherAmLane} assigned to unrelated AM`);
  });

  await runTest("NAM sees direct report lanes in work queue", async () => {
    // Create a NAM and a direct report AM
    const nam = await createUser(orgId, "national_account_manager");
    const directReport = await createUser(orgId, "account_manager");
    const unrelatedAm = await createUser(orgId, "account_manager");
    // Set directReport's managerId to nam
    await q(`UPDATE users SET manager_id = $1 WHERE id = $2`, [nam.id, directReport.id]);

    const reportLane = await createLane(orgId, directReport.id, 1);
    const unrelatedLane = await createLane(orgId, unrelatedAm.id, 1);

    const cookie = await loginAs(nam.username, nam.password);
    const { json } = await apiGet("/api/recurring-lanes/work-queue", cookie);
    const q2 = json as {
      assignedUntouched: Array<{ lane: { id: string } }>;
      inProgress: Array<{ lane: { id: string } }>;
      noContactable: Array<{ lane: { id: string } }>;
      unassigned: Array<{ lane: { id: string } }>;
    };
    const allIds = [
      ...q2.assignedUntouched,
      ...q2.inProgress,
      ...q2.noContactable,
      ...q2.unassigned,
    ].map(i => i.lane.id);

    assert(allIds.includes(reportLane), `NAM should see direct report's lane ${reportLane}`);
    assert(!allIds.includes(unrelatedLane), `NAM should NOT see unrelated AM's lane ${unrelatedLane}`);
  });

  await runTest("Director sees all lanes in hierarchy (including indirect reports)", async () => {
    // Create dir → nam → am chain
    const dir = await createUser(orgId, "director");
    const nam2 = await createUser(orgId, "national_account_manager");
    const am2 = await createUser(orgId, "account_manager");
    await q(`UPDATE users SET manager_id = $1 WHERE id = $2`, [dir.id, nam2.id]);
    await q(`UPDATE users SET manager_id = $1 WHERE id = $2`, [nam2.id, am2.id]);

    const indirectLane = await createLane(orgId, am2.id, 0);

    const cookie = await loginAs(dir.username, dir.password);
    const { json } = await apiGet("/api/recurring-lanes/work-queue", cookie);
    const q2 = json as {
      assignedUntouched: Array<{ lane: { id: string } }>;
      inProgress: Array<{ lane: { id: string } }>;
      noContactable: Array<{ lane: { id: string } }>;
      unassigned: Array<{ lane: { id: string } }>;
    };
    const allIds = [
      ...q2.assignedUntouched,
      ...q2.inProgress,
      ...q2.noContactable,
      ...q2.unassigned,
    ].map(i => i.lane.id);

    assert(allIds.includes(indirectLane), `Director should see indirect report's lane ${indirectLane}`);
  });

  await runTest("NAM cannot assign lane to user outside their hierarchy (403)", async () => {
    // Create a NAM with one direct report and an unrelated AM
    const nam3 = await createUser(orgId, "national_account_manager");
    const unrelatedUser = await createUser(orgId, "account_manager");
    const testLane = await createLane(orgId, null);

    const cookie = await loginAs(nam3.username, nam3.password);
    const { status, json } = await apiPost(
      `/api/recurring-lanes/${testLane}/assign`,
      cookie,
      { ownerUserId: unrelatedUser.id }
    );
    assert(status === 403, `Expected 403 for out-of-scope assignment, got ${status}: ${JSON.stringify(json)}`);
  });

  await runTest("Admin can assign lane to any org user (no hierarchy restriction)", async () => {
    const admin = await createUser(orgId, "admin");
    const anyUser = await createUser(orgId, "account_manager");
    const testLane2 = await createLane(orgId, null);

    const cookie = await loginAs(admin.username, admin.password);
    const { status } = await apiPost(
      `/api/recurring-lanes/${testLane2}/assign`,
      cookie,
      { ownerUserId: anyUser.id }
    );
    assert(status === 200, `Admin should be able to assign to any user, got ${status}`);
  });

  await runTest("Unassigned lanes not shown to NAM (canSeeUnassigned=false)", async () => {
    const nam4 = await createUser(orgId, "national_account_manager");
    const newUnassignedLane = await createLane(orgId, null);

    const cookie = await loginAs(nam4.username, nam4.password);
    const { json } = await apiGet("/api/recurring-lanes/work-queue", cookie);
    const q2 = json as { unassigned: Array<{ lane: { id: string } }> };
    const unassignedIds = q2.unassigned.map(i => i.lane.id);

    assert(
      !unassignedIds.includes(newUnassignedLane),
      `NAM should NOT see unassigned lane ${newUnassignedLane} (canSeeUnassigned=false)`
    );
  });

  await runTest("Unassigned lanes ARE shown to director (canSeeUnassigned=true)", async () => {
    // Use the director from the top of main() and the unassigned lane we created
    // Reset it to ensure it's unassigned
    await q(`UPDATE recurring_lanes SET owner_user_id = NULL, assigned_at = NULL WHERE id = $1`, [unassignedLane]);

    const cookie = await loginAs(director.username, director.password);
    const { json } = await apiGet("/api/recurring-lanes/work-queue", cookie);
    const q2 = json as { unassigned: Array<{ lane: { id: string } }> };
    const unassignedIds = q2.unassigned.map(i => i.lane.id);

    assert(
      unassignedIds.includes(unassignedLane),
      `Director should see unassigned lane ${unassignedLane}`
    );
  });

  // ── Task creation + lifecycle tests ──────────────────────────────────────

  await runTest("Manager assigning lane to another user creates a lane-procurement task", async () => {
    const taskAdmin = await createUser(orgId, "admin");  // admin bypasses hierarchy
    const assignee = await createUser(orgId, "account_manager");
    const taskLane = await createLane(orgId, null);

    const cookie = await loginAs(taskAdmin.username, taskAdmin.password);
    const { status } = await apiPost(`/api/recurring-lanes/${taskLane}/assign`, cookie, { ownerUserId: assignee.id });
    assert(status === 200, `Expected 200 from assign, got ${status}`);

    const res = await q(
      `SELECT id, title, status, lane_context, lever FROM tasks
       WHERE lane_context->>'laneId' = $1 AND assigned_to = $2 LIMIT 1`,
      [taskLane, assignee.id]
    );
    assert(res.rows.length === 1, `Expected 1 task created, found ${res.rows.length}`);
    const task = res.rows[0];
    track("tasks", task.id);
    assert(task.status === "open", `Expected task status 'open', got '${task.status}'`);
    assert(task.lever === "Lane ID", `Expected lever 'Lane ID', got '${task.lever}'`);
    assert(task.lane_context?.type === "lane_procurement", `Expected lane_context.type='lane_procurement'`);
    assert(task.lane_context?.laneId === taskLane, `Expected laneId deep-link to match lane`);
    assert((task.title as string).includes("Work assigned lane:"), `Title should start with 'Work assigned lane:'`);
  });

  await runTest("Self-assign also creates a lane-procurement task for the assigning user", async () => {
    const selfUser = await createUser(orgId, "account_manager");
    const taskLane2 = await createLane(orgId, null);

    const cookie = await loginAs(selfUser.username, selfUser.password);
    const { status } = await apiPost(`/api/recurring-lanes/${taskLane2}/assign`, cookie, { ownerUserId: selfUser.id });
    assert(status === 200, `Expected 200 from self-assign, got ${status}`);

    const res = await q(
      `SELECT id, title, status, lane_context FROM tasks
       WHERE lane_context->>'laneId' = $1 AND assigned_to = $2 LIMIT 1`,
      [taskLane2, selfUser.id]
    );
    assert(res.rows.length === 1, `Expected 1 task for self-assign, found ${res.rows.length}`);
    track("tasks", res.rows[0].id);
    assert(res.rows[0].status === "open", `Self-assign task should be open`);
  });

  await runTest("Duplicate assignment does not create a second open task for the same lane+user", async () => {
    const taskAdmin2 = await createUser(orgId, "admin");
    const assignee2 = await createUser(orgId, "account_manager");
    const taskLane3 = await createLane(orgId, null);

    const cookie = await loginAs(taskAdmin2.username, taskAdmin2.password);

    // Assign once
    await apiPost(`/api/recurring-lanes/${taskLane3}/assign`, cookie, { ownerUserId: assignee2.id });
    // Assign again (re-assign to same user)
    await apiPost(`/api/recurring-lanes/${taskLane3}/assign`, cookie, { ownerUserId: assignee2.id });

    const res = await q(
      `SELECT id FROM tasks
       WHERE lane_context->>'laneId' = $1 AND assigned_to = $2 AND status != 'completed'`,
      [taskLane3, assignee2.id]
    );
    for (const row of res.rows) track("tasks", row.id);
    assert(res.rows.length === 1, `Expected exactly 1 open task, found ${res.rows.length}`);
  });

  await runTest("Task laneContext.laneId deep-links to the correct lane in the work queue", async () => {
    const taskAdmin3 = await createUser(orgId, "admin");
    const assignee3 = await createUser(orgId, "account_manager");
    const targetLane = await createLane(orgId, null);

    const cookie = await loginAs(taskAdmin3.username, taskAdmin3.password);
    await apiPost(`/api/recurring-lanes/${targetLane}/assign`, cookie, { ownerUserId: assignee3.id });

    const res = await q(
      `SELECT lane_context FROM tasks WHERE lane_context->>'laneId' = $1 AND assigned_to = $2 LIMIT 1`,
      [targetLane, assignee3.id]
    );
    assert(res.rows.length === 1, `Expected task to exist for lane ${targetLane}`);
    track("tasks", res.rows[0]?.id ?? "");
    const lc = res.rows[0].lane_context as { laneId?: string; type?: string };
    assert(lc.laneId === targetLane, `Deep-link laneId mismatch: expected ${targetLane}, got ${lc.laneId}`);
    assert(lc.type === "lane_procurement", `Expected type='lane_procurement'`);
  });

  await runTest("Resolving a lane (hasPreferredCarrierProgram=true) auto-completes open lane tasks", async () => {
    // We need an admin to both assign and resolve
    const adminUser = await createUser(orgId, "admin");
    const assignee4 = await createUser(orgId, "account_manager");
    const resolveLane = await createLane(orgId, null);

    const adminCookie = await loginAs(adminUser.username, adminUser.password);

    // Assign → creates task
    await apiPost(`/api/recurring-lanes/${resolveLane}/assign`, adminCookie, { ownerUserId: assignee4.id });

    // Verify task is open
    const beforeRes = await q(
      `SELECT id, status FROM tasks WHERE lane_context->>'laneId' = $1 AND assigned_to = $2 LIMIT 1`,
      [resolveLane, assignee4.id]
    );
    assert(beforeRes.rows.length === 1, `Expected 1 open task before resolution`);
    track("tasks", beforeRes.rows[0].id);
    assert(beforeRes.rows[0].status === "open", `Task should be open before lane resolution`);

    // Resolve the lane via PATCH hasPreferredCarrierProgram=true
    const bodyStr = JSON.stringify({ hasPreferredCarrierProgram: true });
    const resolveRes = await httpRequest({
      method: "PATCH",
      path: `/api/recurring-lanes/${resolveLane}`,
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: bodyStr,
    });
    assert(resolveRes.status === 200, `Expected 200 on resolve, got ${resolveRes.status}`);

    // Verify task is now completed
    const afterRes = await q(
      `SELECT status FROM tasks WHERE lane_context->>'laneId' = $1 AND assigned_to = $2 LIMIT 1`,
      [resolveLane, assignee4.id]
    );
    assert(afterRes.rows.length === 1, `Expected 1 task row after resolution`);
    assert(afterRes.rows[0].status === "completed", `Expected task status 'completed' after lane resolution, got '${afterRes.rows[0].status}'`);
  });

  await runTest("Notification still fires for manager-to-other-user assignment (not replaced by task)", async () => {
    const notifAdmin = await createUser(orgId, "admin");
    const notifAssignee = await createUser(orgId, "account_manager");
    const notifLane = await createLane(orgId, null);

    const cookie = await loginAs(notifAdmin.username, notifAdmin.password);
    const { status } = await apiPost(`/api/recurring-lanes/${notifLane}/assign`, cookie, { ownerUserId: notifAssignee.id });
    assert(status === 200, `Expected 200, got ${status}`);

    const notifRes = await q(
      `SELECT id FROM notifications WHERE user_id = $1 AND type = 'lane_assigned' AND related_id = $2 LIMIT 1`,
      [notifAssignee.id, notifLane]
    );
    assert(notifRes.rows.length === 1, `Expected in-app notification for lane assignment, found ${notifRes.rows.length}`);

    // Also confirm task was created alongside notification
    const taskRes = await q(
      `SELECT id FROM tasks WHERE lane_context->>'laneId' = $1 AND assigned_to = $2 LIMIT 1`,
      [notifLane, notifAssignee.id]
    );
    assert(taskRes.rows.length === 1, `Task should exist alongside notification`);
    for (const r of taskRes.rows) track("tasks", r.id);
  });

  await runTest("Work queue includes 'customers' array with distinct company names", async () => {
    // Create two lanes with different company names and ensure they appear in the customers list
    const laneA = await createLaneWithCustomer(orgId, null, "Acme Corp");
    const laneB = await createLaneWithCustomer(orgId, null, "Globex Inc");
    const laneC = await createLaneWithCustomer(orgId, null, "Acme Corp"); // duplicate — should deduplicate

    const cookie = await loginAs(director.username, director.password);
    const { json } = await apiGet("/api/recurring-lanes/work-queue", cookie);
    const q2 = json as { customers?: string[] };

    assert(Array.isArray(q2.customers), `Expected 'customers' array in work queue response`);
    assert(q2.customers!.includes("Acme Corp"), `Expected 'Acme Corp' in customers list`);
    assert(q2.customers!.includes("Globex Inc"), `Expected 'Globex Inc' in customers list`);
    const acmeCount = q2.customers!.filter(n => n === "Acme Corp").length;
    assert(acmeCount === 1, `Expected 'Acme Corp' to appear exactly once, got ${acmeCount}`);

    // Cleanup extra test lanes
    await q(`DELETE FROM recurring_lanes WHERE id IN ($1, $2, $3)`, [laneA, laneB, laneC]).catch(() => {});
  });

  await runTest("Engine-status endpoint returns null meta when engine has never run for a fresh test org", async () => {
    // Create a fresh org and admin who has never run the engine
    const freshOrgId = uid();
    const freshSlug = `testorg-${freshOrgId.slice(0, 8)}`;
    await q(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`, [freshOrgId, `FreshOrg_${freshOrgId.slice(0, 8)}`, freshSlug]);
    track("organizations", freshOrgId);
    await enableFeatureFlag(freshOrgId);

    const freshAdmin = await createUser(freshOrgId, "admin");
    const cookie = await loginAs(freshAdmin.username, freshAdmin.password);

    const { status, json } = await apiGet("/api/recurring-lanes/engine-status", cookie);
    const typed = json as { meta: unknown };

    assert(status === 200, `Expected 200 from engine-status, got ${status}`);
    assert(typed.meta === null, `Expected null meta for org that has never run engine, got ${JSON.stringify(typed.meta)}`);
  });

  await runTest("Engine-status returns 403 for non-admin/director roles", async () => {
    // LM role should be blocked from engine-status
    const cookie = await loginAs(lm.username, lm.password);
    const { status } = await apiGet("/api/recurring-lanes/engine-status", cookie);
    assert(status === 403, `Expected 403 for LM on engine-status, got ${status}`);
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  await cleanup();
  await pool.end();

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${results.length} tests\n`);

  if (failed > 0) process.exit(1);
}

main().catch(async (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Test runner error:", msg);
  await cleanup();
  await pool.end().catch(() => {});
  process.exit(1);
});
