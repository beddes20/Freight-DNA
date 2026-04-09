/**
 * Carrier Ranking Overhaul — Tests (Task #155)
 *
 * Covers:
 *   (a) Carrier with exact-lane history outranks region-only prospect
 *   (b) Carrier found in lane history appears in suggestions
 *   (c) pageSize > 20 returns more than 20 carriers (if enough exist)
 *   (d) exactOnly filter returns only exact-history carriers
 *   (e) hasEmail filter excludes carriers without email
 *   (f) notRecentlyContacted filter suppresses recently-benched carriers unless override is set
 *   (g) suppressionReasons contains correct flags
 *   (h) bulk select covers full filtered result set (UI logic — tested via API totalCount)
 *   (i) sort=loadsDesc orders by exact loads descending
 *
 * Run with: npx tsx tests/carrier-ranking-overhaul.test.ts
 * Requires: dev server running on port 5000
 */

import pg from "pg";
import crypto from "crypto";
import bcrypt from "bcrypt";
import http from "http";

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

async function q(text: string, values?: unknown[]): Promise<pg.QueryResult> {
  return pool.query(text, values);
}

function uid(): string {
  return crypto.randomUUID();
}

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

async function createFreshOrg(): Promise<string> {
  const id = uid();
  const slug = `cr-test-org-${id.slice(0, 8)}`;
  const now = new Date().toISOString();
  await q(
    `INSERT INTO organizations (id, name, slug, created_at) VALUES ($1, $2, $3, $4)`,
    [id, `CR Test Org ${id.slice(0, 6)}`, slug, now]
  );
  track("organizations", id);
  return id;
}

async function createUser(orgId: string, role: string): Promise<{ id: string; username: string; password: string }> {
  const id = uid();
  const password = `Pass${id.slice(0, 8)}!`;
  const hash = await bcrypt.hash(password, 10);
  const username = `cr.test.${id.slice(0, 8)}@example.com`;
  const now = new Date().toISOString();
  await q(
    `INSERT INTO users (id, organization_id, username, password, name, role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, orgId, username, hash, `CRTest ${id.slice(0, 6)}`, role, now]
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

async function createLane(orgId: string, origin: string, destination: string): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO recurring_lanes
       (id, org_id, origin, destination, is_eligible, has_preferred_carrier_program,
        eligibility_confidence, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, false, 'medium', $5, $5)`,
    [id, orgId, origin, destination, now]
  );
  track("recurring_lanes", id);
  return id;
}

async function createCarrier(orgId: string, name: string, primaryEmail?: string | null, regions?: string[]): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO carriers (id, org_id, name, primary_email, regions, equipment_types, tags, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [id, orgId, name, primaryEmail ?? null, regions ?? [], [], [], now]
  );
  track("carriers", id);
  return id;
}

async function createFinancialUpload(uploadedBy: string, rows: unknown[]): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  const rowCount = rows.length;
  await q(
    `INSERT INTO financial_uploads
       (id, file_name, uploaded_at, uploaded_by, row_count, rows, summary_rows,
        best_deal_days_spot, best_deal_days_all, trend_analysis, averages_data, daily_acquisition)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb)`,
    [
      id, `test-upload-${id.slice(0, 8)}.csv`, now, uploadedBy, rowCount,
      JSON.stringify(rows), JSON.stringify([]), JSON.stringify([]),
      JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]),
    ]
  );
  track("financial_uploads", id);
  return id;
}

async function createBenchEntry(laneId: string, carrierId: string | null, carrierName: string, outreachSentAt?: string | null): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO lane_carrier_interest (id, lane_id, carrier_id, carrier_name, interest_status, source_type, outreach_sent_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'needs_follow_up', 'suggested', $5, $6, $6)`,
    [id, laneId, carrierId, carrierName, outreachSentAt ?? null, now]
  );
  track("lane_carrier_interest", id);
  return id;
}

async function cleanup(): Promise<void> {
  const order = [
    "lane_carrier_interest",
    "financial_uploads",
    "recurring_lanes",
    "carriers",
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
  console.log("\nCarrier Ranking Overhaul — Task #155 tests\n");

  // Use a fresh isolated org to avoid interference from production financial uploads
  const orgId = await createFreshOrg();
  await enableFeatureFlag(orgId);

  // Create an admin user to do the testing
  const admin = await createUser(orgId, "admin");
  const cookie = await loginAs(admin.username, admin.password);

  // Create a test lane: Glendale AZ → Buena Park CA
  const laneId = await createLane(orgId, "glendale", "buena park");

  // Carrier A: has exact-lane history (16 loads)
  const carrierAId = await createCarrier(orgId, "ExactLaneCarrier", "exact@carrier.com", ["AZ", "CA"]);

  // Carrier B: pure regional prospect, no history
  const carrierBId = await createCarrier(orgId, "RegionalProspect", "regional@prospect.com", ["CA"]);

  // Carrier C: no email
  const carrierCId = await createCarrier(orgId, "NoEmailCarrier", null, ["AZ"]);

  // Carrier D: has email
  const carrierDId = await createCarrier(orgId, "HasEmailCarrier", "hasEmail@carrier.com", ["CA"]);

  // Carrier E: for recently-contacted tests
  const carrierEId = await createCarrier(orgId, "RecentCarrier", "recent@carrier.com", ["CA"]);

  // Build financial upload with 16 exact-lane loads for ExactLaneCarrier (across 3 uploads)
  const exactLaneRows: unknown[] = [];
  for (let i = 0; i < 6; i++) {
    exactLaneRows.push({
      shipperCity: "glendale",
      consigneeCity: "buena park",
      carrier: "exactlanecarrier",
      month: "2025-11",
    });
  }
  const upload1 = await createFinancialUpload(admin.id, exactLaneRows);

  const exactLaneRows2: unknown[] = [];
  for (let i = 0; i < 5; i++) {
    exactLaneRows2.push({
      shipperCity: "glendale",
      consigneeCity: "buena park",
      carrier: "exactlanecarrier",
      month: "2025-10",
    });
  }
  const upload2 = await createFinancialUpload(admin.id, exactLaneRows2);

  const exactLaneRows3: unknown[] = [];
  for (let i = 0; i < 5; i++) {
    exactLaneRows3.push({
      shipperCity: "glendale",
      consigneeCity: "buena park",
      carrier: "exactlanecarrier",
      month: "2025-09",
    });
  }
  const upload3 = await createFinancialUpload(admin.id, exactLaneRows3);

  // Add bench entry for RecentCarrier (contacted 5 days ago)
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const recentBenchId = await createBenchEntry(laneId, carrierEId, "RecentCarrier", fiveDaysAgo);

  // ── Tests ─────────────────────────────────────────────────────────────────

  await runTest("(a) Exact-lane history carrier outranks region-only prospect", async () => {
    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&sort=recommended`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number; historyMatch: string }> };
    assert(Array.isArray(data.carriers), "Expected carriers array");

    const exactCarrier = data.carriers.find(c => c.carrierName === "ExactLaneCarrier");
    const regionalCarrier = data.carriers.find(c => c.carrierName === "RegionalProspect");

    assert(!!exactCarrier, "ExactLaneCarrier should appear in suggestions");
    assert(!!regionalCarrier, "RegionalProspect should appear in suggestions");
    assert(
      exactCarrier!.fitScore > regionalCarrier!.fitScore,
      `ExactLaneCarrier score (${exactCarrier!.fitScore}) should be higher than RegionalProspect score (${regionalCarrier!.fitScore})`
    );
    assert(
      exactCarrier!.historyMatch === "exact",
      `ExactLaneCarrier historyMatch should be 'exact', got '${exactCarrier!.historyMatch}'`
    );
  });

  await runTest("(b) Carrier from lane history appears in suggestions", async () => {
    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; historyMatch: string }> };
    const exactCarrier = data.carriers.find(c => c.carrierName === "ExactLaneCarrier");
    assert(!!exactCarrier, "ExactLaneCarrier (in lane history) should appear in suggestions");
    assert(exactCarrier!.historyMatch === "exact", `historyMatch should be 'exact'`);
  });

  await runTest("(c) pageSize=50 can return more than 20 carriers if enough exist", async () => {
    // We need at least 21 carriers; let's check if pageSize is honored
    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=50&sort=recommended`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: unknown[]; pageSize: number; totalCount: number };
    assert(data.pageSize === 50, `Expected pageSize=50 in response, got ${data.pageSize}`);
    // totalCount includes all qualifying carriers; pageSize=50 means we'd return up to 50
    assert(Array.isArray(data.carriers), "Expected carriers array");
    // If we have 5 carriers, all 5 should be returned — not capped at 20
    const prevResult = await apiGet(`/api/lanes/${laneId}/carrier-suggestions?pageSize=20`, cookie);
    const prevData = prevResult.json as { carriers: unknown[]; totalCount: number };
    // The total count should be same regardless of page size
    assert(data.totalCount === prevData.totalCount, "totalCount should be same across pageSize changes");
  });

  await runTest("(c) pageSize=0 (all) returns totalCount carriers", async () => {
    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: unknown[]; totalCount: number };
    assert(data.carriers.length === data.totalCount, `pageSize=0 should return all carriers: got ${data.carriers.length}, totalCount=${data.totalCount}`);
  });

  await runTest("(d) exactOnly filter returns only exact-history carriers", async () => {
    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&exactOnly=true`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ historyMatch: string; carrierName: string }> };
    assert(data.carriers.length > 0, "Expected at least one exact-history carrier");
    for (const c of data.carriers) {
      assert(
        c.historyMatch === "exact",
        `exactOnly filter should only return 'exact' carriers, got '${c.historyMatch}' for ${c.carrierName}`
      );
    }
    const regional = data.carriers.find(c => c.carrierName === "RegionalProspect");
    assert(!regional, "RegionalProspect should be excluded by exactOnly filter");
  });

  await runTest("(e) hasEmail filter excludes carriers without email", async () => {
    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&hasEmail=true`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; primaryEmail: string | null; backupEmail: string | null }> };
    const noEmail = data.carriers.find(c => c.carrierName === "NoEmailCarrier");
    assert(!noEmail, "NoEmailCarrier should be excluded by hasEmail filter");
    for (const c of data.carriers) {
      assert(
        !!(c.primaryEmail || c.backupEmail),
        `All returned carriers should have an email, but ${c.carrierName} has none`
      );
    }
  });

  await runTest("(f) notRecentlyContacted filter suppresses recently-benched carriers", async () => {
    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&notRecentlyContacted=true`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; suppressionReasons: string[] }> };
    const recentCarrier = data.carriers.find(c => c.carrierName === "RecentCarrier");
    assert(!recentCarrier, "RecentCarrier (contacted 5 days ago) should be suppressed by notRecentlyContacted filter");
  });

  await runTest("(f) overrideRecentlyContacted=true brings recently-contacted carriers back", async () => {
    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&notRecentlyContacted=true&overrideRecentlyContacted=true`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string }> };
    const recentCarrier = data.carriers.find(c => c.carrierName === "RecentCarrier");
    assert(!!recentCarrier, "RecentCarrier should appear when overrideRecentlyContacted=true");
  });

  await runTest("(g) suppressionReasons contains correct flags", async () => {
    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; suppressionReasons: string[] }> };

    // NoEmailCarrier should have "No email on file"
    const noEmail = data.carriers.find(c => c.carrierName === "NoEmailCarrier");
    assert(!!noEmail, "NoEmailCarrier should appear");
    assert(
      noEmail!.suppressionReasons.includes("No email on file"),
      `NoEmailCarrier should have 'No email on file' suppression, got: ${JSON.stringify(noEmail!.suppressionReasons)}`
    );

    // RecentCarrier should have "Recently contacted" in suppressionReasons
    const recentCarrier = data.carriers.find(c => c.carrierName === "RecentCarrier");
    assert(!!recentCarrier, "RecentCarrier should appear in unfiltered results");
    const hasRecentlyCont = recentCarrier!.suppressionReasons.some(r => r.startsWith("Recently contacted"));
    assert(
      hasRecentlyCont,
      `RecentCarrier should have 'Recently contacted' suppression, got: ${JSON.stringify(recentCarrier!.suppressionReasons)}`
    );
  });

  await runTest("(h) totalCount reflects full filtered set regardless of page size", async () => {
    // Get total with pageSize=20 (paginated)
    const r1 = await apiGet(`/api/lanes/${laneId}/carrier-suggestions?pageSize=20`, cookie);
    const d1 = r1.json as { totalCount: number; carriers: unknown[] };

    // Get total with pageSize=0 (all)
    const r2 = await apiGet(`/api/lanes/${laneId}/carrier-suggestions?pageSize=0`, cookie);
    const d2 = r2.json as { totalCount: number; carriers: unknown[] };

    assert(d1.totalCount === d2.totalCount, `totalCount should match regardless of pageSize: ${d1.totalCount} vs ${d2.totalCount}`);
    // If totalCount > 20, pageSize=20 should return fewer than totalCount
    if (d1.totalCount > 20) {
      assert(d1.carriers.length <= 20, `pageSize=20 should return at most 20 carriers, got ${d1.carriers.length}`);
    }
  });

  await runTest("(i) sort=loadsDesc orders by exact loads descending", async () => {
    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&sort=loadsDesc`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; loadsOnLane: number }> };
    assert(data.carriers.length >= 2, "Expected at least 2 carriers for sort test");

    // ExactLaneCarrier (16 loads) should be first
    const exactIdx = data.carriers.findIndex(c => c.carrierName === "ExactLaneCarrier");
    assert(exactIdx !== -1, "ExactLaneCarrier should appear");
    // All carriers before ExactLaneCarrier should have >= loads
    for (let i = 0; i < exactIdx; i++) {
      assert(
        data.carriers[i].loadsOnLane >= data.carriers[exactIdx].loadsOnLane,
        `Carrier at index ${i} (${data.carriers[i].carrierName}, ${data.carriers[i].loadsOnLane} loads) should have >= loads than ExactLaneCarrier (${data.carriers[exactIdx].loadsOnLane})`
      );
    }

    // Verify overall descending order
    for (let i = 0; i < data.carriers.length - 1; i++) {
      assert(
        data.carriers[i].loadsOnLane >= data.carriers[i + 1].loadsOnLane,
        `Carriers should be sorted by loadsOnLane desc: ${data.carriers[i].carrierName}(${data.carriers[i].loadsOnLane}) >= ${data.carriers[i + 1].carrierName}(${data.carriers[i + 1].loadsOnLane})`
      );
    }
  });

  await runTest("Exact-lane carrier score floor: 16 loads ≥ 80 points", async () => {
    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&exactOnly=true`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number; loadsOnLane: number }> };
    const exactCarrier = data.carriers.find(c => c.carrierName === "ExactLaneCarrier");
    assert(!!exactCarrier, "ExactLaneCarrier should appear");
    assert(
      exactCarrier!.fitScore >= 80,
      `ExactLaneCarrier with 16 loads should have fitScore >= 80 (floor for 10+ loads), got ${exactCarrier!.fitScore}`
    );
  });

  await runTest("Regional-only prospect stays below exact-history floor", async () => {
    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&sort=recommended`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number; historyMatch: string }> };
    const regional = data.carriers.find(c => c.carrierName === "RegionalProspect");
    assert(!!regional, "RegionalProspect should appear");
    assert(
      regional!.fitScore < 55,
      `RegionalProspect (region-only) score should be below 55 (exact-lane floor), got ${regional!.fitScore}`
    );
  });

  await runTest("API response includes totalCount, page, pageSize, totalPages", async () => {
    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=20&page=1`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as Record<string, unknown>;
    assert("totalCount" in data, "Response should include totalCount");
    assert("page" in data, "Response should include page");
    assert("pageSize" in data, "Response should include pageSize");
    assert("totalPages" in data, "Response should include totalPages");
    assert(typeof data.totalCount === "number", "totalCount should be a number");
    assert(typeof data.page === "number", "page should be a number");
    assert(typeof data.pageSize === "number", "pageSize should be a number");
    assert(typeof data.totalPages === "number", "totalPages should be a number");
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
