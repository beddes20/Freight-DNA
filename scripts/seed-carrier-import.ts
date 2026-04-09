/**
 * Seed script: Carrier Import End-to-End Proof of Life
 *
 * This script:
 * 1. Targets the demo org (slug="demo") — fails if not found
 * 2. Enables the lane_carrier_outreach_v1 feature flag persistently
 *    (feature_flags table: id, org_id, flag_key, enabled, updated_at)
 * 3. Finds or creates an eligible recurring lane for that org
 * 4. Calls storage.importCarriersForLane() with 3 controlled test carriers
 *    (name, email, AND mcDot all set on each carrier — no mocking)
 * 5. Prints before/after SELECT COUNT(*) from carriers, carrier_import_batches,
 *    lane_carrier_interest as proof
 * 6. Prints concrete carrier IDs
 * 7. Verifies imported carriers are visible via authenticated HTTP calls to:
 *    GET /api/carriers (Admin Catalog) and GET /api/carrier-hub (Carrier Hub)
 *
 * Run with: npx tsx scripts/seed-carrier-import.ts
 * Requires server running on localhost:5000 for API verification steps.
 */

import http from "http";
import { type Organization } from "../shared/schema";
import { storage } from "../server/storage";

const SERVER_HOST = "127.0.0.1";
const SERVER_PORT = 5000;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpPost(
  path: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: Record<string, string | string[]> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: SERVER_HOST,
        port: SERVER_PORT,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
          "Connection": "close",
          ...headers,
        },
      },
      res => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk; });
        res.on("end", () => {
          const hdrs: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) hdrs[k.toLowerCase()] = v;
          }
          resolve({ status: res.statusCode ?? 0, body: data, headers: hdrs });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpGet(
  path: string,
  cookie: string
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: SERVER_HOST,
        port: SERVER_PORT,
        path,
        method: "GET",
        headers: { Cookie: cookie, Connection: "close" },
      },
      res => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk; });
        res.on("end", () => {
          let json: unknown;
          try { json = JSON.parse(data); } catch { json = data; }
          resolve({ status: res.statusCode ?? 0, json });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function loginAndGetCookie(username: string, password: string): Promise<string> {
  const body = JSON.stringify({ username, password });
  const res = await httpPost("/api/auth/login", body);
  if (res.status !== 200) {
    throw new Error(`Login failed for ${username}: HTTP ${res.status} — ${res.body}`);
  }
  const rawCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(rawCookie) ? rawCookie : rawCookie ? [rawCookie] : [];
  const sessionCookie = cookies.find(c => c.startsWith("connect.sid"))?.split(";")[0];
  if (!sessionCookie) throw new Error("No connect.sid cookie in login response");
  return sessionCookie;
}

// ── Org lookup ────────────────────────────────────────────────────────────────

async function findOrgBySlug(slug: string): Promise<Organization | undefined> {
  const res = await storage.pool.query<{ id: string; name: string; slug: string }>(
    "SELECT id, name, slug FROM organizations WHERE slug = $1 LIMIT 1",
    [slug]
  );
  return res.rows[0] as unknown as Organization | undefined;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n=== Carrier Import Seed: End-to-End Proof of Life ===\n");

  const pool = storage.pool;

  // ── 1. Find demo org by slug="demo" (no silent fallback) ─────────────────
  const org = await findOrgBySlug("demo");
  if (!org) {
    throw new Error(
      "Demo org (slug='demo') not found. Run seed-demo-org.ts first to create it."
    );
  }
  console.log(`Target org: ${org.name} (slug=${org.slug}, id=${org.id})`);

  // ── 2. Enable feature flag persistently ───────────────────────────────────
  // Feature flags stored in: feature_flags (id, org_id, flag_key, enabled, updated_at)
  await storage.setFeatureFlag(org.id, "lane_carrier_outreach_v1", true);
  const flagEnabled = await storage.getFeatureFlag(org.id, "lane_carrier_outreach_v1");
  if (!flagEnabled) throw new Error("Failed to enable feature flag — cannot proceed.");

  const flagRow = await pool.query(
    "SELECT id, org_id, flag_key, enabled, updated_at FROM feature_flags WHERE org_id = $1 AND flag_key = 'lane_carrier_outreach_v1'",
    [org.id]
  );
  if (flagRow.rows.length === 0) throw new Error("feature_flags row not found after upsert");
  const fr = flagRow.rows[0];
  console.log(`Feature flag: flag_key=${fr.flag_key} | enabled=${fr.enabled} | org_id=${fr.org_id}`);

  // ── 3. Find or create an eligible recurring lane ──────────────────────────
  const allLanes = await storage.getRecurringLanes(org.id);
  let lane = allLanes.find(l => l.isEligible);
  if (!lane) {
    const orgUsers = await storage.getUsers(org.id);
    if (orgUsers.length === 0) throw new Error("No users in org — cannot create a lane.");
    const ownerUser = orgUsers[0];
    console.log(`No eligible lane found, creating one owned by: ${ownerUser.username}`);
    lane = await storage.createRecurringLane({
      orgId: org.id,
      origin: "Memphis",
      originState: "TN",
      destination: "Atlanta",
      destinationState: "GA",
      equipmentType: "Dry Van",
      isEligible: true,
      hasPreferredCarrierProgram: false,
      ownerUserId: ownerUser.id,
      carriersContactedCount: 0,
      eligibilityConfidence: "medium",
      isManual: true,
    });
    console.log(`Created lane: ${lane.id}`);
  } else {
    console.log(`Using existing lane: ${lane.id} (${lane.origin} → ${lane.destination})`);
  }

  // ── 4. Get admin user for attribution ─────────────────────────────────────
  const orgUsers = await storage.getUsers(org.id);
  const adminUser = orgUsers.find(u => u.role === "admin") ?? orgUsers[0];
  if (!adminUser) throw new Error("No users found in org");
  console.log(`Importing as user: ${adminUser.username} (role=${adminUser.role})`);

  // ── 5. Print BEFORE counts ────────────────────────────────────────────────
  async function getOrgCount(table: string): Promise<number> {
    const r = await pool.query(`SELECT COUNT(*) FROM ${table} WHERE org_id = $1`, [org!.id]);
    return parseInt(r.rows[0].count);
  }
  async function getInterestCount(): Promise<number> {
    const r = await pool.query(
      `SELECT COUNT(*) FROM lane_carrier_interest lci
       JOIN carriers c ON c.id = lci.carrier_id WHERE c.org_id = $1`,
      [org!.id]
    );
    return parseInt(r.rows[0].count);
  }

  const beforeCarriers = await getOrgCount("carriers");
  const beforeBatches = await getOrgCount("carrier_import_batches");
  const beforeInterest = await getInterestCount();

  console.log("\n── Before Import ─────────────────────────────────────────────");
  console.log(`  carriers:               ${beforeCarriers}`);
  console.log(`  carrier_import_batches: ${beforeBatches}`);
  console.log(`  lane_carrier_interest:  ${beforeInterest}`);

  // ── 6. Define 3 test carriers — all with name, email, AND mcDot set ───────
  const uniqueSuffix = Date.now().toString(36);
  const testCarriers = [
    {
      name: `Apex Road Freight ${uniqueSuffix}`,
      email: `dispatch.apex.${uniqueSuffix}@apexfreight.com`,
      mcDot: `MC${Math.floor(Math.random() * 900000 + 100000)}`,
    },
    {
      name: `Blue Ridge Logistics ${uniqueSuffix}`,
      email: `ops.blueridge.${uniqueSuffix}@blueridge.com`,
      mcDot: `MC${Math.floor(Math.random() * 900000 + 100000)}`,
    },
    {
      name: `Summit Transport LLC ${uniqueSuffix}`,
      email: `contact.summit.${uniqueSuffix}@summittransport.com`,
      mcDot: `MC${Math.floor(Math.random() * 900000 + 100000)}`,
    },
  ];

  console.log("\n── Importing 3 carriers (name + email + mcDot all set) ───────");
  testCarriers.forEach((c, i) =>
    console.log(`  ${i + 1}. ${c.name} | email=${c.email} | mcDot=${c.mcDot}`)
  );

  // ── 7. Call importCarriersForLane (real storage layer — no mocking) ───────
  const { batch, results } = await storage.importCarriersForLane(
    org.id,
    lane.id,
    adminUser.id,
    testCarriers,
    "dat",
    testCarriers.map(c => c.name).join("\n")
  );

  // ── 8. Print AFTER counts ─────────────────────────────────────────────────
  const afterCarriers = await getOrgCount("carriers");
  const afterBatches = await getOrgCount("carrier_import_batches");
  const afterInterest = await getInterestCount();

  console.log("\n── After Import ──────────────────────────────────────────────");
  console.log(`  carriers:               ${afterCarriers} (+${afterCarriers - beforeCarriers})`);
  console.log(`  carrier_import_batches: ${afterBatches} (+${afterBatches - beforeBatches})`);
  console.log(`  lane_carrier_interest:  ${afterInterest} (+${afterInterest - beforeInterest})`);

  // ── 9. Batch details ──────────────────────────────────────────────────────
  console.log("\n── Import Batch ──────────────────────────────────────────────");
  console.log(`  Batch ID:      ${batch.id}`);
  console.log(`  Lane ID:       ${batch.laneId}`);
  console.log(`  Source:        ${batch.source}`);
  console.log(`  Carrier count: ${batch.carrierCount}`);
  console.log(`  New: ${batch.newCount} | Matched: ${batch.matchedCount}`);

  // ── 10. Print carrier IDs ─────────────────────────────────────────────────
  const newCarrierIds = results.map(r => r.carrier.id);
  console.log("\n── Imported Carrier IDs ──────────────────────────────────────");
  for (const r of results) {
    console.log(`  ${r.status.padEnd(8)} | bench=${r.addedToBench} | id=${r.carrier.id} | name=${r.carrier.name}`);
  }

  // ── 11. DB verification ───────────────────────────────────────────────────
  const verifyCarriers = await pool.query(
    "SELECT id, name, source_channel FROM carriers WHERE id = ANY($1)",
    [newCarrierIds]
  );
  console.log("\n── DB: carriers table ────────────────────────────────────────");
  for (const row of verifyCarriers.rows) {
    console.log(`  id=${row.id} | source_channel=${row.source_channel} | name=${row.name}`);
  }

  const verifyBench = await pool.query(
    "SELECT carrier_id, lane_id, source_type FROM lane_carrier_interest WHERE carrier_id = ANY($1)",
    [newCarrierIds]
  );
  console.log("\n── DB: lane_carrier_interest table ───────────────────────────");
  for (const row of verifyBench.rows) {
    console.log(`  carrier_id=${row.carrier_id} | lane_id=${row.lane_id} | source_type=${row.source_type}`);
  }

  // ── 12. Live API verification (authenticated HTTP — hard failure) ──────────
  console.log("\n── API Verification (live HTTP) ──────────────────────────────");

  // The demo org always has admin@freightdna-demo.com / Demo1234! as seeded credentials.
  // We target this known user explicitly so login is deterministic regardless of which
  // user was chosen for storage-layer attribution above.
  const DEMO_ADMIN_USERNAME = "admin@freightdna-demo.com";
  const DEMO_ADMIN_PASSWORD = "Demo1234!";
  const sessionCookie = await loginAndGetCookie(DEMO_ADMIN_USERNAME, DEMO_ADMIN_PASSWORD);
  console.log(`  Authenticated as: ${DEMO_ADMIN_USERNAME}`);

  // Verify GET /api/carriers (Admin Catalog — Drizzle ORM, returns camelCase)
  const catalogRes = await httpGet("/api/carriers", sessionCookie);
  if (catalogRes.status !== 200) {
    throw new Error(`GET /api/carriers returned ${catalogRes.status}: ${JSON.stringify(catalogRes.json)}`);
  }
  const catalogList = catalogRes.json as Array<{ id: string; name: string; sourceChannel: string }>;
  const foundInCatalog = catalogList.filter(c => newCarrierIds.includes(c.id));
  console.log(`  GET /api/carriers → 200 (${catalogList.length} total carriers in catalog)`);
  if (foundInCatalog.length !== results.length) {
    throw new Error(`Expected ${results.length} imported carriers in /api/carriers, found ${foundInCatalog.length}`);
  }
  if (!foundInCatalog.every(c => c.sourceChannel === "dat")) {
    throw new Error("Some carriers have wrong sourceChannel in /api/carriers");
  }
  console.log(`    All ${foundInCatalog.length} imported carriers visible with sourceChannel=dat ✓`);

  // Verify GET /api/carrier-hub (Carrier Hub — raw SQL, returns snake_case)
  const hubRes = await httpGet("/api/carrier-hub", sessionCookie);
  if (hubRes.status !== 200) {
    throw new Error(`GET /api/carrier-hub returned ${hubRes.status}: ${JSON.stringify(hubRes.json)}`);
  }
  const hubData = hubRes.json as { carriers: Array<{ id: string; name: string; source_channel: string }> };
  const allHubCarriers = hubData.carriers ?? [];
  const foundInHub = allHubCarriers.filter(c => newCarrierIds.includes(c.id));
  console.log(`  GET /api/carrier-hub → 200 (${allHubCarriers.length} total carriers in hub)`);
  if (foundInHub.length !== results.length) {
    throw new Error(`Expected ${results.length} imported carriers in /api/carrier-hub, found ${foundInHub.length}`);
  }
  if (!foundInHub.every(c => c.source_channel === "dat")) {
    throw new Error("Some carriers have wrong source_channel in /api/carrier-hub");
  }
  console.log(`    All ${foundInHub.length} imported carriers visible with source_channel=dat ✓`);

  // ── 13. Assertions ────────────────────────────────────────────────────────
  console.log("\n── Final Assertions ──────────────────────────────────────────");

  if (afterBatches <= beforeBatches) throw new Error("No new row in carrier_import_batches");
  console.log("  ✓ carrier_import_batches has ≥1 new row");

  if (afterCarriers < beforeCarriers + 3) {
    throw new Error(`Expected ≥3 new carriers, got +${afterCarriers - beforeCarriers}`);
  }
  console.log("  ✓ carriers table has ≥3 new rows");

  if (afterInterest < beforeInterest + 3) {
    throw new Error(`Expected ≥3 new bench rows, got +${afterInterest - beforeInterest}`);
  }
  console.log("  ✓ lane_carrier_interest has ≥3 new rows linked by carrier_id");

  if (!results.filter(r => r.status === "new").every(r => r.carrier.sourceChannel === "dat")) {
    throw new Error("Not all new carriers have sourceChannel=dat");
  }
  console.log("  ✓ New carriers have source_channel=dat");

  if (verifyBench.rows.length < 3) throw new Error("Not all carriers appear in lane_carrier_interest");
  console.log("  ✓ All carriers appear in lane_carrier_interest");

  const concreteId = results[0].carrier.id;
  console.log(`\n  ✓ Concrete carrier ID: ${concreteId}`);
  console.log(`    GET /api/carriers (Admin Catalog)`);
  console.log(`    GET /api/carrier-hub (Carrier Hub)`);

  console.log("\n=== Seed script completed successfully ===\n");
  await pool.end();
  process.exit(0);
}

main().catch(err => {
  console.error("\n[SEED ERROR]", err.message ?? err);
  process.exit(1);
});
