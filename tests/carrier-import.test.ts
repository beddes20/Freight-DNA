/**
 * Phase 2 Carrier Import Tests
 *
 * Covers:
 *   - Dedup: email exact match → returns matched, not new
 *   - Dedup: MC/DOT exact match → returns matched, not new
 *   - Dedup: normalized name fuzzy match → returns matched, not new
 *   - Dedup: truly new carrier → created and returned as status='new'
 *   - Import endpoint: creates batch record with correct counts
 *   - Import endpoint: upserts lane bench entries for all imported carriers
 *   - Import endpoint: sets sourceChannel on new carriers
 *   - Import endpoint: enriches matched carrier with new email if missing
 *   - Import batches endpoint: lists batches for lane
 *   - Sourcing performance endpoint: returns per-channel stats
 *   - Import validation: empty carriers array returns 400
 *   - Import validation: feature flag off returns 403
 *
 * Run with: npx tsx tests/carrier-import.test.ts
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

async function apiPost(path: string, cookie: string, body: unknown): Promise<{ status: number; json: unknown }> {
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

// ── Fixture helpers ───────────────────────────────────────────────────────────

async function getDefaultOrgId(): Promise<string> {
  const res = await q("SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1");
  if (res.rows.length === 0) throw new Error("No organizations found");
  return res.rows[0].id as string;
}

async function createUser(orgId: string, role: string): Promise<{ id: string; username: string; password: string }> {
  const id = uid();
  const password = `Pass${id.slice(0, 8)}!`;
  const hash = await bcrypt.hash(password, 10);
  const username = `ci.test.${id.slice(0, 8)}@example.com`;
  const now = new Date().toISOString();
  await q(
    `INSERT INTO users (id, organization_id, username, password, name, role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, orgId, username, hash, `CITest ${id.slice(0, 6)}`, role, now]
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

async function disableFeatureFlag(orgId: string): Promise<void> {
  await q(
    `INSERT INTO feature_flags (id, org_id, flag_key, enabled, updated_at)
     VALUES ($1, $2, 'lane_carrier_outreach_v1', false, $3)
     ON CONFLICT (org_id, flag_key) DO UPDATE SET enabled = false`,
    [uid(), orgId, new Date().toISOString()]
  );
}

async function createLane(
  orgId: string,
  ownerUserId: string,
  opts: { origin?: string; destination?: string; equipment?: string } = {}
): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  const origin = opts.origin ?? "Memphis";
  const dest = opts.destination ?? "Atlanta";
  const equip = opts.equipment ?? "Dry Van";
  await q(
    `INSERT INTO recurring_lanes
       (id, org_id, origin, origin_state, destination, destination_state, equipment_type,
        is_eligible, has_preferred_carrier_program,
        owner_user_id, carriers_contacted_count, eligibility_confidence, created_at, updated_at)
     VALUES ($1, $2, $3, 'TN', $4, 'GA', $5, true, false, $6, 0, 'medium', $7, $7)`,
    [id, orgId, origin, dest, equip, ownerUserId, now]
  );
  track("recurring_lanes", id);
  return id;
}

async function createCarrierInDB(
  orgId: string,
  name: string,
  opts: { primaryEmail?: string; mcDot?: string; sourceChannel?: string } = {}
): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO carriers (id, org_id, name, primary_email, mc_dot, source_channel, regions, equipment_types, tags, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, '{}', '{}', '{}', $7, $7)`,
    [id, orgId, name, opts.primaryEmail ?? null, opts.mcDot ?? null, opts.sourceChannel ?? null, now]
  );
  track("carriers", id);
  return id;
}

// ── Main test suite ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n=== Phase 2 Carrier Import Tests ===\n");

  const orgId = await getDefaultOrgId();
  await enableFeatureFlag(orgId);

  const adminUser = await createUser(orgId, "admin");
  const adminCookie = await loginAs(adminUser.username, adminUser.password);

  const namUser = await createUser(orgId, "national_account_manager");
  const namCookie = await loginAs(namUser.username, namUser.password);

  const laneId = await createLane(orgId, namUser.id);

  // ── Dedup tests (via import endpoint) ────────────────────────────────────

  await runTest("Dedup: email exact match → status=matched, matchType=email_exact", async () => {
    const email = `exact.email.${uid().slice(0, 8)}@matchtest.com`;
    const carrierId = await createCarrierInDB(orgId, "Match Email Carrier LLC", { primaryEmail: email });

    const res = await apiPost(`/api/lanes/${laneId}/import-carriers`, adminCookie, {
      carriers: [{ name: "Different Name Transport", email }],
      source: "dat",
    });
    assert(res.status === 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.json)}`);

    const { results: importResults } = res.json as { results: Array<{ status: string; matchType: string; carrier: { id: string } }> };
    assert(importResults.length === 1, `Expected 1 result, got ${importResults.length}`);
    assert(importResults[0].status === "matched", `Expected status=matched, got ${importResults[0].status}`);
    assert(importResults[0].matchType === "email_exact", `Expected email_exact, got ${importResults[0].matchType}`);
    assert(importResults[0].carrier.id === carrierId, "Expected matched carrier ID");

    // cleanup bench entry created
    await q("DELETE FROM lane_carrier_interest WHERE carrier_id = $1", [carrierId]);
  });

  await runTest("Dedup: MC/DOT exact match → status=matched, matchType=mc_exact", async () => {
    const mcDot = `MC${Math.floor(Math.random() * 9000000 + 1000000)}`;
    const carrierId = await createCarrierInDB(orgId, "MC Match Trucking Inc", { mcDot });

    const res = await apiPost(`/api/lanes/${laneId}/import-carriers`, adminCookie, {
      carriers: [{ name: "Unrelated Name Here", mcDot }],
      source: "loadsmart",
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);

    const { results: importResults } = res.json as { results: Array<{ status: string; matchType: string }> };
    assert(importResults[0].status === "matched", `Expected matched, got ${importResults[0].status}`);
    assert(importResults[0].matchType === "mc_exact", `Expected mc_exact, got ${importResults[0].matchType}`);

    await q("DELETE FROM lane_carrier_interest WHERE carrier_id = $1", [carrierId]);
  });

  await runTest("Dedup: normalized name fuzzy match → status=matched, matchType=name_fuzzy", async () => {
    const carrierId = await createCarrierInDB(orgId, "Summit Logistics LLC");

    // "Summit Logistics" normalizes to "SUMMIT" same as "Summit Logistics Inc"
    const res = await apiPost(`/api/lanes/${laneId}/import-carriers`, adminCookie, {
      carriers: [{ name: "Summit Logistics Inc" }],
      source: "manual",
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);

    const { results: importResults } = res.json as { results: Array<{ status: string; matchType: string }> };
    assert(importResults[0].status === "matched", `Expected matched, got ${importResults[0].status}`);
    assert(importResults[0].matchType === "name_fuzzy", `Expected name_fuzzy, got ${importResults[0].matchType}`);

    await q("DELETE FROM lane_carrier_interest WHERE carrier_id = $1", [carrierId]);
  });

  await runTest("Dedup: truly new carrier → status=new, created in catalog with sourceChannel", async () => {
    const uniqueName = `Totally New Carrier ${uid().slice(0, 8)}`;
    const email = `new.${uid().slice(0, 8)}@carrier.com`;

    const res = await apiPost(`/api/lanes/${laneId}/import-carriers`, adminCookie, {
      carriers: [{ name: uniqueName, email, mcDot: "MC9999001" }],
      source: "dat",
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);

    const { results: importResults } = res.json as { results: Array<{ status: string; carrier: { id: string; name: string } }> };
    assert(importResults[0].status === "new", `Expected new, got ${importResults[0].status}`);

    const newId = importResults[0].carrier.id;
    track("carriers", newId);

    // Verify carrier created with sourceChannel
    const row = await q("SELECT source_channel, primary_email FROM carriers WHERE id = $1", [newId]);
    assert(row.rows.length > 0, "New carrier not found in DB");
    assert(row.rows[0].source_channel === "dat", `Expected source_channel=dat, got ${row.rows[0].source_channel}`);
    assert(row.rows[0].primary_email === email, `Email not persisted: ${row.rows[0].primary_email}`);

    await q("DELETE FROM lane_carrier_interest WHERE carrier_id = $1", [newId]);
  });

  // ── Batch record tests ────────────────────────────────────────────────────

  await runTest("Import endpoint: creates batch record with correct counts", async () => {
    const name1 = `BatchTest One ${uid().slice(0, 6)}`;
    const name2 = `BatchTest Two ${uid().slice(0, 6)}`;
    const existingId = await createCarrierInDB(orgId, name1);

    const res = await apiPost(`/api/lanes/${laneId}/import-carriers`, adminCookie, {
      carriers: [
        { name: name1 },
        { name: name2, email: `bt2.${uid().slice(0, 6)}@example.com` },
      ],
      source: "csv_paste",
      rawInput: `${name1}\n${name2}`,
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);

    const { batch, results: importResults } = res.json as {
      batch: { id: string; newCount: number; matchedCount: number; carrierCount: number; source: string };
      results: unknown[];
    };
    assert(batch.carrierCount === 2, `Expected carrierCount=2, got ${batch.carrierCount}`);
    assert(batch.newCount === 1, `Expected newCount=1, got ${batch.newCount}`);
    assert(batch.matchedCount === 1, `Expected matchedCount=1, got ${batch.matchedCount}`);
    assert(batch.source === "csv_paste", `Expected source=csv_paste, got ${batch.source}`);
    track("carrier_import_batches", batch.id);

    // cleanup
    const newCarrier = (importResults as Array<{ status: string; carrier: { id: string } }>)
      .find(r => r.status === "new")?.carrier;
    if (newCarrier) {
      await q("DELETE FROM lane_carrier_interest WHERE carrier_id = $1", [newCarrier.id]);
      await q("DELETE FROM carriers WHERE id = $1", [newCarrier.id]);
    }
    await q("DELETE FROM lane_carrier_interest WHERE carrier_id = $1", [existingId]);
  });

  await runTest("Import endpoint: upserts bench entries for all carriers (laneId context)", async () => {
    const uniqueName = `BenchEntry Test ${uid().slice(0, 8)}`;

    const res = await apiPost(`/api/lanes/${laneId}/import-carriers`, adminCookie, {
      carriers: [{ name: uniqueName }],
      source: "dat",
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);

    const { results: importResults } = res.json as { results: Array<{ carrier: { id: string }; addedToBench: boolean }> };
    const carrierId = importResults[0].carrier.id;
    track("carriers", carrierId);
    assert(importResults[0].addedToBench === true, "Expected addedToBench=true");

    // Verify bench entry in DB
    const bench = await q("SELECT * FROM lane_carrier_interest WHERE lane_id = $1 AND carrier_id = $2", [laneId, carrierId]);
    assert(bench.rows.length > 0, "No bench entry created for imported carrier");
    assert(bench.rows[0].source_type === "manually_added", `Expected manually_added, got ${bench.rows[0].source_type}`);

    await q("DELETE FROM lane_carrier_interest WHERE carrier_id = $1", [carrierId]);
  });

  await runTest("Import endpoint: enriches matched carrier with new email if was missing", async () => {
    const carrierId = await createCarrierInDB(orgId, `NoEmail Carrier ${uid().slice(0, 8)}`);
    const newEmail = `enriched.${uid().slice(0, 8)}@carrier.com`;

    const row = await q("SELECT primary_email FROM carriers WHERE id = $1", [carrierId]);
    assert(row.rows[0].primary_email === null, "Carrier should start with no email");

    const res = await apiPost(`/api/lanes/${laneId}/import-carriers`, adminCookie, {
      carriers: [{ name: `NoEmail Carrier ${carrierId.slice(0, 8)}`, email: newEmail }],
      source: "manual",
    });
    // even if not matched by name (unique prefix), create new — email enrichment applies to matched only
    // Let's seed by exact email enrich on a separate existing carrier with no email
    const carrierById = await q("SELECT primary_email FROM carriers WHERE id = $1", [carrierId]);
    // The carrier was not matched (different name used), so just ensure no error
    assert(res.status === 201, `Expected 201, got ${res.status}`);

    // Now test explicit email enrichment: import carrier with matching name, provide email
    const noEmailName = `EnrichMe ${uid().slice(0, 8)}`;
    const cId2 = await createCarrierInDB(orgId, noEmailName + " LLC");
    const enrichEmail = `enrich2.${uid().slice(0, 8)}@test.com`;
    const res2 = await apiPost(`/api/lanes/${laneId}/import-carriers`, adminCookie, {
      carriers: [{ name: noEmailName + " LLC", email: enrichEmail }],
      source: "manual",
    });
    assert(res2.status === 201, `Expected 201, got ${res2.status}`);
    const { results: r2 } = res2.json as { results: Array<{ status: string; carrier: { id: string } }> };
    assert(r2[0].status === "matched", `Expected matched, got ${r2[0].status}`);

    const updated = await q("SELECT primary_email FROM carriers WHERE id = $1", [cId2]);
    assert(updated.rows[0].primary_email === enrichEmail, `Email not enriched: ${updated.rows[0].primary_email}`);

    await q("DELETE FROM lane_carrier_interest WHERE carrier_id IN ($1, $2)", [carrierId, cId2]);
    const newId = (res.json as { results: Array<{ status: string; carrier: { id: string } }> }).results
      .find(r => r.status === "new")?.carrier?.id;
    if (newId) { await q("DELETE FROM lane_carrier_interest WHERE carrier_id = $1", [newId]); await q("DELETE FROM carriers WHERE id = $1", [newId]); }
  });

  // ── Import batches endpoint ────────────────────────────────────────────────

  await runTest("Import batches endpoint: GET /api/lanes/:laneId/import-batches lists batches", async () => {
    const batchName = `BatchListTest ${uid().slice(0, 8)}`;
    const res1 = await apiPost(`/api/lanes/${laneId}/import-carriers`, adminCookie, {
      carriers: [{ name: batchName }],
      source: "dat",
    });
    assert(res1.status === 201, `Import failed: ${res1.status}`);
    const { batch } = res1.json as { batch: { id: string } };
    track("carrier_import_batches", batch.id);

    const listRes = await apiGet(`/api/lanes/${laneId}/import-batches`, adminCookie);
    assert(listRes.status === 200, `Expected 200, got ${listRes.status}`);

    const batches = listRes.json as Array<{ id: string; laneId: string; source: string }>;
    assert(Array.isArray(batches), "Expected array of batches");
    const found = batches.find(b => b.id === batch.id);
    assert(!!found, "Created batch not found in list");

    // cleanup
    const { results: importResults } = res1.json as { results: Array<{ status: string; carrier: { id: string } }> };
    const newId = importResults.find(r => r.status === "new")?.carrier?.id;
    if (newId) { await q("DELETE FROM lane_carrier_interest WHERE carrier_id = $1", [newId]); await q("DELETE FROM carriers WHERE id = $1", [newId]); }
  });

  // ── Sourcing performance endpoint ─────────────────────────────────────────

  await runTest("Sourcing performance endpoint: returns channels with stats", async () => {
    // Seed a carrier with known sourceChannel
    const perfName = `PerfTest ${uid().slice(0, 8)}`;
    const carrierId = await createCarrierInDB(orgId, perfName, { sourceChannel: "dat" });

    const res = await apiGet("/api/carriers/sourcing-performance", adminCookie);
    assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.json)}`);

    const channels = res.json as Array<{
      sourceChannel: string;
      label: string;
      carriersImported: number;
      outreached: number;
      responded: number;
      responseRate: number;
    }>;
    assert(Array.isArray(channels), "Expected array");

    const datChannel = channels.find(c => c.sourceChannel === "dat");
    assert(!!datChannel, "Expected 'dat' channel in results");
    assert(datChannel!.carriersImported >= 1, `Expected at least 1 carrier, got ${datChannel!.carriersImported}`);
    assert(typeof datChannel!.label === "string", "Expected label string");
    assert(typeof datChannel!.responseRate === "number", "Expected responseRate number");
  });

  // ── Validation tests ──────────────────────────────────────────────────────

  await runTest("Import validation: empty carriers array returns 400", async () => {
    const res = await apiPost(`/api/lanes/${laneId}/import-carriers`, adminCookie, {
      carriers: [],
      source: "dat",
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await runTest("Import validation: missing source returns 400", async () => {
    const res = await apiPost(`/api/lanes/${laneId}/import-carriers`, adminCookie, {
      carriers: [{ name: "Test Carrier" }],
      source: "",
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await runTest("Import validation: feature flag off returns 403", async () => {
    await disableFeatureFlag(orgId);
    const res = await apiPost(`/api/lanes/${laneId}/import-carriers`, adminCookie, {
      carriers: [{ name: "Test" }],
      source: "dat",
    });
    assert(res.status === 403, `Expected 403, got ${res.status}`);
    await enableFeatureFlag(orgId); // re-enable for other tests
  });

  await runTest("Import: NAM role (non-admin) can import carriers", async () => {
    const uniqueName = `NAMImport ${uid().slice(0, 8)}`;
    const res = await apiPost(`/api/lanes/${laneId}/import-carriers`, namCookie, {
      carriers: [{ name: uniqueName }],
      source: "manual",
    });
    assert(res.status === 201, `NAM should be able to import, got ${res.status}: ${JSON.stringify(res.json)}`);

    const { results: importResults } = res.json as { results: Array<{ carrier: { id: string }; status: string }> };
    const newId = importResults.find(r => r.status === "new")?.carrier?.id;
    if (newId) {
      await q("DELETE FROM lane_carrier_interest WHERE carrier_id = $1", [newId]);
      await q("DELETE FROM carriers WHERE id = $1", [newId]);
    }
  });

  // ── Teardown ──────────────────────────────────────────────────────────────

  console.log("\n── Cleanup ───────────────────────────────────────────────────────\n");

  // Clean up import batches first (FK refs lane_carrier_interest via carrier)
  await q("DELETE FROM carrier_import_batches WHERE org_id = $1 AND created_by = ANY($2)", [
    orgId,
    [adminUser.id, namUser.id],
  ]);

  for (const { table, id } of cleanupIds) {
    try {
      if (table === "recurring_lanes") {
        await q("DELETE FROM lane_carrier_interest WHERE lane_id = $1", [id]);
        await q("DELETE FROM carrier_outreach_logs WHERE lane_id = $1", [id]);
      }
      await q(`DELETE FROM ${table} WHERE id = $1`, [id]);
    } catch {
      // best-effort
    }
  }

  // ── Results ───────────────────────────────────────────────────────────────

  console.log("\n── Results ───────────────────────────────────────────────────────\n");
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`Tests: ${passed} passed, ${failed} failed (${results.length} total)`);

  if (failed > 0) {
    console.log("\nFailed tests:");
    results.filter(r => !r.passed).forEach(r => console.log(`  ✗ ${r.name}\n    ${r.error}`));
    process.exit(1);
  }

  await pool.end();
  console.log("\n✓ All carrier import tests passed.");
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
