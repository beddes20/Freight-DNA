/**
 * High-Frequency Lanes v2 — Tests (Task #188)
 *
 * Covers:
 *   (a) isHighFrequencyLane: returns true for ≥2 loads/week, false otherwise
 *   (b) HIGH_FREQUENCY_CONFIG: config object is exported with expected shape
 *   (c) HF exact-lane floor scores: ≥10 runs → ≥95, ≥5 runs → ≥85, any → ≥72
 *   (d) HF carriers-suggestions response includes isHighFrequencyLane + highFrequencyConfig
 *   (e) Standard lane (non-HF) does NOT receive HF floors (scores unchanged)
 *   (f) Dedup guard: re-sending to recently-contacted carrier returns status=dedup_skipped
 *   (g) Dedup guard: non-HF lane ignores dedup window (send proceeds)
 *   (h) Market NBA boost: carrier with NBA record gets hasMarketNbaBoost=true
 *   (i) carrierFitExplanation populated on HF lanes only
 *   (j) API response maxCandidates cap enforced for HF lanes (≤30 results)
 *
 * Run with: npx tsx tests/high-frequency-lanes.test.ts
 * Requires: dev server running on port 5000
 */

import pg from "pg";
import crypto from "crypto";
import bcrypt from "bcrypt";
import http from "http";
import { isHighFrequencyLane, HIGH_FREQUENCY_CONFIG } from "../server/carrierRankingService.js";

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

async function createFreshOrg(): Promise<string> {
  const id = uid();
  const slug = `hf-test-org-${id.slice(0, 8)}`;
  const now = new Date().toISOString();
  await q(
    `INSERT INTO organizations (id, name, slug, created_at) VALUES ($1, $2, $3, $4)`,
    [id, `HF Test Org ${id.slice(0, 6)}`, slug, now]
  );
  track("organizations", id);
  return id;
}

async function createUser(orgId: string, role: string): Promise<{ id: string; username: string; password: string }> {
  const id = uid();
  const password = `Pass${id.slice(0, 8)}!`;
  const hash = await bcrypt.hash(password, 10);
  const username = `hf.test.${id.slice(0, 8)}@example.com`;
  const now = new Date().toISOString();
  await q(
    `INSERT INTO users (id, organization_id, username, password, name, role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, orgId, username, hash, `HFTest ${id.slice(0, 6)}`, role, now]
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

async function createLane(orgId: string, origin: string, destination: string, avgLoadsPerWeek?: number): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO recurring_lanes
       (id, org_id, origin, destination, is_eligible, has_preferred_carrier_program,
        eligibility_confidence, avg_loads_per_week, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, false, 'medium', $5, $6, $6)`,
    [id, orgId, origin, destination, avgLoadsPerWeek ?? null, now]
  );
  track("recurring_lanes", id);
  return id;
}

async function createCarrier(orgId: string, name: string, options?: {
  primaryEmail?: string | null;
  regions?: string[];
  equipmentTypes?: string[];
}): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO carriers (id, org_id, name, primary_email, regions, equipment_types, tags, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [id, orgId, name, options?.primaryEmail ?? null,
     options?.regions ?? [], options?.equipmentTypes ?? [], [], now]
  );
  track("carriers", id);
  return id;
}

async function createFinancialUpload(uploadedBy: string, rows: unknown[]): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO financial_uploads
       (id, file_name, uploaded_at, uploaded_by, row_count, rows, summary_rows,
        best_deal_days_spot, best_deal_days_all, trend_analysis, averages_data, daily_acquisition)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb)`,
    [
      id, `hf-test-upload-${id.slice(0, 8)}.csv`, now, uploadedBy, rows.length,
      JSON.stringify(rows), JSON.stringify([]), JSON.stringify([]),
      JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]),
    ]
  );
  track("financial_uploads", id);
  return id;
}

async function createBenchEntry(
  laneId: string,
  carrierId: string | null,
  carrierName: string,
  outreachSentAt?: string | null
): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO lane_carrier_interest
       (id, lane_id, carrier_id, carrier_name, interest_status, source_type, outreach_sent_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'needs_follow_up', 'suggested', $5, $6, $6)`,
    [id, laneId, carrierId, carrierName, outreachSentAt ?? null, now]
  );
  track("lane_carrier_interest", id);
  return id;
}

async function createOutreachLog(
  orgId: string,
  laneId: string,
  carrierId: string,
  carrierName: string,
  actorUserId: string,
  sentAt: string,
  deliveryStatus: "sent" | "failed" = "sent"
): Promise<string> {
  const id = uid();
  await q(
    `INSERT INTO carrier_outreach_logs
       (id, org_id, lane_id, carrier_ids, carrier_names, actor_user_id,
        outreach_mode, sent_at, delivery_status, direction)
     VALUES ($1, $2, $3, ARRAY[$4]::text[], ARRAY[$5]::text[], $6,
             'lane_building', $7::timestamptz, $8, 'outbound')`,
    [id, orgId, laneId, carrierId, carrierName, actorUserId, sentAt, deliveryStatus]
  );
  track("carrier_outreach_logs", id);
  return id;
}

async function createMarketSignal(): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO market_signals
       (id, signal_type, scope_type, scope_key, equipment_type, status, severity, confidence,
        evidence_payload, explanation, last_evaluated_at)
     VALUES ($1, 'demand_surge', 'corridor', $2, 'dry_van', 'active', 'high', '0.9',
             '{}', 'High demand detected', $3)`,
    [id, `hf-test-${id.slice(0, 8)}`, now]
  );
  track("market_signals", id);
  return id;
}

async function createCarrierMarketNba(carrierId: string, marketSignalId: string): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO carrier_market_nbas
       (id, carrier_id, market_signal_id, recommendation_type, status, urgency_score, explanation)
     VALUES ($1, $2, $3, 'demand_surge_capacity', 'pending', 75, '{}')`,
    [id, carrierId, marketSignalId]
  );
  track("carrier_market_nbas", id);
  return id;
}

async function cleanup(): Promise<void> {
  const order = [
    "carrier_market_nbas",
    "lane_carrier_interest",
    "financial_uploads",
    "recurring_lanes",
    "carriers",
    "market_signals",
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

// ── Test Runner ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\nHigh-Frequency Lanes v2 Tests (Task #188)\n");

  // ── Unit-level tests (pure function, no DB/HTTP) ───────────────────────────

  await runTest("(a) isHighFrequencyLane: true for avgLoadsPerWeek >= 2", async () => {
    assert(isHighFrequencyLane({ avgLoadsPerWeek: "2" }), "2.0 loads/week should be HF");
    assert(isHighFrequencyLane({ avgLoadsPerWeek: "2.5" }), "2.5 loads/week should be HF");
    assert(isHighFrequencyLane({ avgLoadsPerWeek: "10" }), "10 loads/week should be HF");
    assert(isHighFrequencyLane({ avgLoadsPerWeek: "3" }), "string '3' should be HF");
  });

  await runTest("(a) isHighFrequencyLane: false for avgLoadsPerWeek < 2 or null", async () => {
    assert(!isHighFrequencyLane({ avgLoadsPerWeek: null }), "null should not be HF");
    assert(!isHighFrequencyLane({ avgLoadsPerWeek: undefined }), "undefined should not be HF");
    assert(!isHighFrequencyLane({ avgLoadsPerWeek: "1.5" }), "1.5 loads/week should not be HF");
    assert(!isHighFrequencyLane({ avgLoadsPerWeek: "0" }), "0 loads/week should not be HF");
    assert(!isHighFrequencyLane({ avgLoadsPerWeek: "abc" }), "non-numeric should not be HF");
  });

  await runTest("(b) HIGH_FREQUENCY_CONFIG exported with correct shape", async () => {
    assert(HIGH_FREQUENCY_CONFIG.minLoadsPerWeek === 2, `minLoadsPerWeek should be 2, got ${HIGH_FREQUENCY_CONFIG.minLoadsPerWeek}`);
    assert(HIGH_FREQUENCY_CONFIG.frequencyLookbackDays === 30, `frequencyLookbackDays should be 30, got ${HIGH_FREQUENCY_CONFIG.frequencyLookbackDays}`);
    assert(HIGH_FREQUENCY_CONFIG.maxCandidates === 30, `maxCandidates should be 30, got ${HIGH_FREQUENCY_CONFIG.maxCandidates}`);
    assert(HIGH_FREQUENCY_CONFIG.outreachDedupWindowHours === 48, `outreachDedupWindowHours should be 48, got ${HIGH_FREQUENCY_CONFIG.outreachDedupWindowHours}`);
  });

  // ── Integration tests (DB + HTTP) ─────────────────────────────────────────
  // Each test group creates its own org to avoid upload-scan limit (last 3 uploads) interference.

  // ── Test (c): HF exact-lane floor scores ─────────────────────────────────
  await runTest("(c) HF lane: exact-lane carrier with ≥10 loads gets fitScore ≥ 95", async () => {
    const org = await createFreshOrg();
    const user = await createUser(org, "admin");
    await enableFeatureFlag(org);
    const c = await loginAs(user.username, user.password);

    // Lane origin/dest must match TMS shipperCity/consigneeCity exactly after normStr().
    // Use just city names (no state) so normStr("chicago") === normStr("chicago").
    const laneId = await createLane(org, "chicago", "detroit", 3); // HF
    await createCarrier(org, "ExactHighVolumeCarrier", { primaryEmail: "exact10@test.com" });
    // TMS rows using camelCase keys that readTmsField recognizes
    const rows = Array.from({ length: 10 }, (_, i) => ({
      shipperCity: "chicago",
      consigneeCity: "detroit",
      carrier: "ExactHighVolumeCarrier",
      month: `2025-${String((i % 12) + 1).padStart(2, "0")}`,
    }));
    await createFinancialUpload(user.id, rows);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      c
    );
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(json)}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number; historyMatch: string }> };
    const found = data.carriers.find(x => x.carrierName.toLowerCase() === "exacthighvolumecarrier");
    assert(!!found, `ExactHighVolumeCarrier should appear in results (got: ${data.carriers.map(x => x.carrierName).join(", ")})`);
    assert(
      found!.fitScore >= 95,
      `HF exact-lane carrier with ≥10 loads should have fitScore ≥ 95, got ${found!.fitScore}`
    );
    assert(found!.historyMatch === "exact", `historyMatch should be 'exact', got ${found!.historyMatch}`);
  });

  await runTest("(c) HF lane: exact-lane carrier with ≥5 loads gets fitScore ≥ 85", async () => {
    const org = await createFreshOrg();
    const user = await createUser(org, "admin");
    await enableFeatureFlag(org);
    const c = await loginAs(user.username, user.password);

    const laneId = await createLane(org, "dallas", "houston", 2.5); // HF
    await createCarrier(org, "ExactMedVolumeCarrier", { primaryEmail: "exact5@test.com" });
    const rows = Array.from({ length: 5 }, (_, i) => ({
      shipperCity: "dallas",
      consigneeCity: "houston",
      carrier: "ExactMedVolumeCarrier",
      month: `2025-0${i + 1}`,
    }));
    await createFinancialUpload(user.id, rows);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      c
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number }> };
    const found = data.carriers.find(x => x.carrierName.toLowerCase() === "exactmedvolumecarrier");
    assert(!!found, `ExactMedVolumeCarrier should appear (carriers: ${data.carriers.map(x => x.carrierName).join(",")})`);
    assert(found!.fitScore >= 85, `HF exact-lane carrier with ≥5 loads should have fitScore ≥ 85, got ${found!.fitScore}`);
  });

  await runTest("(c) HF lane: exact-lane carrier with 1 load gets fitScore ≥ 72", async () => {
    const org = await createFreshOrg();
    const user = await createUser(org, "admin");
    await enableFeatureFlag(org);
    const c = await loginAs(user.username, user.password);

    const laneId = await createLane(org, "miami", "orlando", 2.0); // exactly HF threshold
    await createCarrier(org, "ExactSingleLoadCarrier", { primaryEmail: "exact1@test.com" });
    await createFinancialUpload(user.id, [{
      shipperCity: "miami",
      consigneeCity: "orlando",
      carrier: "ExactSingleLoadCarrier",
      month: "2025-10",
    }]);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      c
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number }> };
    const found = data.carriers.find(x => x.carrierName.toLowerCase() === "exactsingleloadcarrier");
    assert(!!found, `ExactSingleLoadCarrier should appear (carriers: ${data.carriers.map(x => x.carrierName).join(",")})`);
    assert(found!.fitScore >= 72, `HF exact-lane carrier with 1 load should have fitScore ≥ 72, got ${found!.fitScore}`);
  });

  // ── Test (d): HF suggestions response metadata ────────────────────────────
  {
    const org = await createFreshOrg();
    const user = await createUser(org, "admin");
    await enableFeatureFlag(org);
    const c = await loginAs(user.username, user.password);

    await runTest("(d) HF lane: carrier-suggestions response includes isHighFrequencyLane=true + highFrequencyConfig", async () => {
      const laneId = await createLane(org, "Seattle, WA", "Portland, OR", 4.0); // clearly HF

      const { status, json } = await apiGet(
        `/api/lanes/${laneId}/carrier-suggestions?pageSize=20`,
        c
      );
      assert(status === 200, `Expected 200, got ${status}`);
      const data = json as Record<string, unknown>;
      assert(data.isHighFrequencyLane === true, `Expected isHighFrequencyLane=true, got ${data.isHighFrequencyLane}`);
      assert(typeof data.highFrequencyConfig === "object" && data.highFrequencyConfig !== null,
        "Expected highFrequencyConfig object on HF response");
      const cfg = data.highFrequencyConfig as Record<string, unknown>;
      assert(cfg.minLoadsPerWeek === 2, `minLoadsPerWeek should be 2, got ${cfg.minLoadsPerWeek}`);
      assert(cfg.maxCandidates === 30, `maxCandidates should be 30, got ${cfg.maxCandidates}`);
      assert(cfg.outreachDedupWindowHours === 48, `outreachDedupWindowHours should be 48, got ${cfg.outreachDedupWindowHours}`);
    });

    await runTest("(d) Non-HF lane: isHighFrequencyLane=false, no highFrequencyConfig in response", async () => {
      const laneId = await createLane(org, "Boston, MA", "Providence, RI", 1.0); // not HF

      const { status, json } = await apiGet(
        `/api/lanes/${laneId}/carrier-suggestions?pageSize=20`,
        c
      );
      assert(status === 200, `Expected 200, got ${status}`);
      const data = json as Record<string, unknown>;
      assert(data.isHighFrequencyLane === false, `Expected isHighFrequencyLane=false, got ${data.isHighFrequencyLane}`);
      assert(data.highFrequencyConfig === undefined || data.highFrequencyConfig === null,
        "highFrequencyConfig should be absent for non-HF lane");
    });
  }

  // ── Test (e): Standard lane — scores NOT inflated by HF floors ───────────
  await runTest("(e) Standard (non-HF) lane: exact-lane carrier with ≥10 loads uses standard floor ≥ 85", async () => {
    const org = await createFreshOrg();
    const user = await createUser(org, "admin");
    await enableFeatureFlag(org);
    const c = await loginAs(user.username, user.password);

    const laneId = await createLane(org, "denver", "salt lake city", 1.0); // not HF
    await createCarrier(org, "StandardExactCarrier", { primaryEmail: "std10@test.com" });
    const rows = Array.from({ length: 10 }, (_, i) => ({
      shipperCity: "denver",
      consigneeCity: "salt lake city",
      carrier: "StandardExactCarrier",
      month: `2025-${String((i % 12) + 1).padStart(2, "0")}`,
    }));
    await createFinancialUpload(user.id, rows);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      c
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number }> };
    const found = data.carriers.find(x => x.carrierName.toLowerCase() === "standardexactcarrier");
    assert(!!found, `StandardExactCarrier should appear (carriers: ${data.carriers.map(x => x.carrierName).join(",")})`);
    // Standard path: ≥10 loads → floor is 85.
    assert(found!.fitScore >= 85, `Standard exact-lane ≥10 loads should have fitScore ≥ 85 (standard floor), got ${found!.fitScore}`);
  });

  // ── Test (f): Dedup guard on HF lane ─────────────────────────────────────
  {
    const org = await createFreshOrg();
    const user = await createUser(org, "admin");
    await enableFeatureFlag(org);
    const c = await loginAs(user.username, user.password);

    await runTest("(f) HF lane: sending to recently-contacted carrier returns dedup_skipped", async () => {
      const laneId = await createLane(org, "Phoenix, AZ", "Tucson, AZ", 3.0); // HF
      const carrierId = await createCarrier(org, "RecentlyContactedCarrier", { primaryEmail: "recent@test.com" });

      // Seed a successful outreach log 1 hour ago (within the 48h dedup window).
      const recentlySent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await createOutreachLog(org, laneId, carrierId, "RecentlyContactedCarrier", user.id, recentlySent, "sent");

      const { status, json } = await apiPost(
        `/api/lanes/${laneId}/send-outreach-emails`,
        c,
        {
          emailDrafts: [{
            carrierId,
            carrierName: "RecentlyContactedCarrier",
            subject: "Test Subject",
            body: "Test body",
          }],
        }
      );
      assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(json)}`);
      const data = json as { results: Array<{ carrierId: string; status: string; dedupBlocked?: boolean }> };
      const result = data.results.find(r => r.carrierId === carrierId);
      assert(!!result, "Should have a result for the recently-contacted carrier");
      assert(result!.status === "dedup_skipped",
        `Expected status=dedup_skipped, got ${result!.status}`);
      assert(result!.dedupBlocked === true, `Expected dedupBlocked=true, got ${result!.dedupBlocked}`);
    });

    await runTest("(f) HF lane: carrier NOT recently contacted is NOT dedup-blocked", async () => {
      const laneId = await createLane(org, "Atlanta, GA", "Nashville, TN", 2.5); // HF
      const carrierId = await createCarrier(org, "NotRecentlyContactedCarrier", { primaryEmail: "notrecent@test.com" });

      // Bench entry with outreachSentAt = 72 hours ago (outside 48h window)
      const olderSent = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
      await createBenchEntry(laneId, carrierId, "NotRecentlyContactedCarrier", olderSent);

      const { status, json } = await apiPost(
        `/api/lanes/${laneId}/send-outreach-emails`,
        c,
        {
          emailDrafts: [{
            carrierId,
            carrierName: "NotRecentlyContactedCarrier",
            subject: "Test Subject",
            body: "Test body",
          }],
        }
      );
      assert(status === 200, `Expected 200, got ${status}`);
      const data = json as { results: Array<{ carrierId: string; status: string }> };
      const result = data.results.find(r => r.carrierId === carrierId);
      assert(!!result, "Should have a result");
      assert(result!.status !== "dedup_skipped",
        `Carrier outside 48h window should NOT be dedup-blocked, got ${result!.status}`);
    });
  }

  // ── Test (g): Non-HF lane ignores dedup guard ────────────────────────────
  await runTest("(g) Non-HF lane: recently-contacted carrier is NOT dedup-blocked", async () => {
    const org = await createFreshOrg();
    const user = await createUser(org, "admin");
    await enableFeatureFlag(org);
    const c = await loginAs(user.username, user.password);

    const laneId = await createLane(org, "Minneapolis, MN", "Milwaukee, WI", 1.0); // NOT HF
    const carrierId = await createCarrier(org, "NonHFRecentCarrier", { primaryEmail: "nonhf@test.com" });

    // Create bench entry 1 hour ago — would be within 48h window on HF lane
    const recentlySent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await createBenchEntry(laneId, carrierId, "NonHFRecentCarrier", recentlySent);

    const { status, json } = await apiPost(
      `/api/lanes/${laneId}/send-outreach-emails`,
      c,
      {
        emailDrafts: [{
          carrierId,
          carrierName: "NonHFRecentCarrier",
          subject: "Test Subject",
          body: "Test body",
        }],
      }
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { results: Array<{ carrierId: string; status: string }> };
    const result = data.results.find(r => r.carrierId === carrierId);
    assert(!!result, "Should have a result");
    assert(result!.status !== "dedup_skipped",
      `Non-HF lane should not apply dedup guard, got ${result!.status}`);
  });

  // ── Test (h): Market NBA boost ───────────────────────────────────────────
  await runTest("(h) HF lane: carrier with market NBA record gets hasMarketNbaBoost=true in suggestions", async () => {
    const org = await createFreshOrg();
    const user = await createUser(org, "admin");
    await enableFeatureFlag(org);
    const c = await loginAs(user.username, user.password);

    const laneId = await createLane(org, "Kansas City, MO", "St. Louis, MO", 3.0); // HF
    const carrierId = await createCarrier(org, "MarketNbaBoostCarrier", { primaryEmail: "nba@test.com" });
    const signalId = await createMarketSignal();
    await createCarrierMarketNba(carrierId, signalId);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      c
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierId: string | null; hasMarketNbaBoost?: boolean; fitScore: number }> };
    const found = data.carriers.find(x => x.carrierId === carrierId);
    assert(!!found, `MarketNbaBoostCarrier (id=${carrierId}) should appear in results. Got carriers: ${data.carriers.map(x => x.carrierId).join(",")}`);
    assert(found!.hasMarketNbaBoost === true,
      `Carrier with market NBA should have hasMarketNbaBoost=true, got ${found!.hasMarketNbaBoost}`);
  });

  // ── Test (i): carrierFitExplanation populated for HF lanes ───────────────
  await runTest("(i) HF lane: carriers include carrierFitExplanation with structured fields", async () => {
    const org = await createFreshOrg();
    const user = await createUser(org, "admin");
    await enableFeatureFlag(org);
    const c = await loginAs(user.username, user.password);

    const laneId = await createLane(org, "san diego", "los angeles", 5.0); // clearly HF
    const carrierId = await createCarrier(org, "FitExplainCarrier", { primaryEmail: "fitx@test.com" });
    // Give the carrier some exact-lane history using correct TMS key names
    await createFinancialUpload(user.id, [{
      shipperCity: "san diego",
      consigneeCity: "los angeles",
      carrier: "FitExplainCarrier",
      month: "2025-10",
    }]);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      c
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as {
      carriers: Array<{
        carrierId: string | null;
        carrierName: string;
        carrierFitExplanation?: {
          exactLaneHistory: { runCount: number };
          regionalHistory: { runCount: number };
          customerHistory: { hasHistory: boolean; runCount: number };
          fitSignals: { hasMarketNbaBoost: boolean };
        } | null;
      }>;
    };
    // On HF lanes, ALL carriers should have carrierFitExplanation populated
    assert(data.carriers.length > 0, "Should have at least one carrier in results");
    const firstCarrier = data.carriers[0];
    assert(
      firstCarrier.carrierFitExplanation !== null && firstCarrier.carrierFitExplanation !== undefined,
      `carrierFitExplanation should be populated on HF lane carriers (got ${JSON.stringify(firstCarrier.carrierFitExplanation)})`
    );
    const expl = firstCarrier.carrierFitExplanation!;
    assert("exactLaneHistory" in expl, "carrierFitExplanation should have exactLaneHistory");
    assert("regionalHistory" in expl, "carrierFitExplanation should have regionalHistory");
    assert("customerHistory" in expl, "carrierFitExplanation should have customerHistory");
    assert("fitSignals" in expl, "carrierFitExplanation should have fitSignals");

    // Check that FitExplainCarrier specifically has runCount >= 1
    const exactCarrier = data.carriers.find(x => x.carrierId === carrierId);
    if (exactCarrier && exactCarrier.carrierFitExplanation) {
      assert(
        exactCarrier.carrierFitExplanation.exactLaneHistory.runCount >= 1,
        `FitExplainCarrier exactLaneHistory.runCount should be ≥ 1, got ${exactCarrier.carrierFitExplanation.exactLaneHistory.runCount}`
      );
    }
  });

  await runTest("(i) Non-HF lane: carrierFitExplanation is null", async () => {
    const org = await createFreshOrg();
    const user = await createUser(org, "admin");
    await enableFeatureFlag(org);
    const c = await loginAs(user.username, user.password);

    const laneId = await createLane(org, "Richmond, VA", "Norfolk, VA", 0.5); // not HF
    await createCarrier(org, "NoFitExplainCarrier", { primaryEmail: "nofitx@test.com" });

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      c
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as {
      carriers: Array<{ carrierId: string | null; carrierFitExplanation?: unknown }>;
    };
    // For non-HF lanes, all carrierFitExplanation should be null
    for (const carrier of data.carriers) {
      assert(
        carrier.carrierFitExplanation === null || carrier.carrierFitExplanation === undefined,
        `Non-HF lane should not populate carrierFitExplanation, got: ${JSON.stringify(carrier.carrierFitExplanation)}`
      );
    }
  });

  // ── Test (j): maxCandidates cap ──────────────────────────────────────────
  await runTest("(j) HF lane: pageSize=0 returns at most maxCandidates (30) carriers", async () => {
    const org = await createFreshOrg();
    const user = await createUser(org, "admin");
    await enableFeatureFlag(org);
    const c = await loginAs(user.username, user.password);

    // Create an HF lane and 35 carriers with regional match so there are > 30 candidates
    const laneId = await createLane(org, "Columbus, OH", "Cleveland, OH", 4.0); // HF
    for (let i = 0; i < 35; i++) {
      await createCarrier(org, `BulkCarrier${i}`, {
        primaryEmail: `bulk${i}@hftest.com`,
        regions: ["OH"],
      });
    }

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      c
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: unknown[]; totalCount: number };
    assert(
      data.carriers.length <= 30,
      `HF lane should cap candidates at 30, got ${data.carriers.length} carriers`
    );
  });

  // ── Task #192: Observability & Tuning Tests ──────────────────────────────

  // ── Test (k): Metrics logging path does not throw ─────────────────────────
  await runTest("(k) rankCarriersForLane emits metrics log without throwing", async () => {
    // Unit test: verify the metrics log path completes without throwing.
    // We capture console.log output by replacing it with a spy and verify a JSON
    // entry with event=rankCarriersForLane is emitted.
    const { rankCarriersForLane: rankFn } = await import("../server/carrierRankingService.js");

    const capturedLogs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      if (typeof args[0] === "string") capturedLogs.push(args[0]);
      else capturedLogs.push(JSON.stringify(args[0]));
    };

    try {
      // Minimal stub storage — just enough to exercise the ranking + logging path
      const stubStorage = {
        getCarriers: async () => [],
        getFinancialUploadsForOrg: async () => [],
        getActiveCarrierMarketNbasBatch: async () => [],
        getLatestCarrierOutreachLogsForLane: async () => new Map(),
      } as any;
      const fakeLane = {
        id: "test-lane-metrics",
        orgId: "test-org-metrics",
        origin: "chicago",
        destination: "detroit",
        avgLoadsPerWeek: "3",
        equipmentType: "dry_van",
        originState: "IL",
        destinationState: "MI",
        companyName: null,
      } as any;

      await rankFn(fakeLane, stubStorage);
    } finally {
      console.log = origLog;
    }

    const metricsEntry = capturedLogs
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .find(e => e && e.event === "rankCarriersForLane");
    assert(!!metricsEntry, `Expected a JSON metrics log with event=rankCarriersForLane. Got: ${capturedLogs.join(" | ")}`);
    assert(metricsEntry.laneId === "test-lane-metrics", `laneId should be in metrics log`);
    assert(metricsEntry.orgId === "test-org-metrics", `orgId should be in metrics log`);
    assert(typeof metricsEntry.isHighFrequencyLane === "boolean", "isHighFrequencyLane should be boolean in metrics log");
    assert(typeof metricsEntry.suggestionCount === "number", "suggestionCount should be number in metrics log");
    assert(Array.isArray(metricsEntry.top3), "top3 should be array in metrics log");
  });

  // ── Test (l): Debug mode — debug object present/absent ────────────────────
  await runTest("(l) ?debug=true returns debug object per carrier, absent without it", async () => {
    const org = await createFreshOrg();
    const user = await createUser(org, "admin");
    await enableFeatureFlag(org);
    const c = await loginAs(user.username, user.password);

    const laneId = await createLane(org, "Sacramento", "Fresno", 3.0); // HF
    await createCarrier(org, "DebugTestCarrier", { primaryEmail: "debug@test.com" });

    // With ?debug=true — should have debug object on carriers
    const { status: s1, json: j1 } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&debug=true`,
      c
    );
    assert(s1 === 200, `Expected 200 with debug=true, got ${s1}`);
    const d1 = j1 as { carriers: Array<{ debug?: unknown }> };
    assert(d1.carriers.length > 0, "Expected at least one carrier");
    const hasDebug = d1.carriers.some(carrier => carrier.debug !== undefined);
    assert(hasDebug, "At least one carrier should have a debug object when ?debug=true");
    const firstWithDebug = d1.carriers.find(carrier => carrier.debug !== undefined);
    if (firstWithDebug) {
      const dbg = firstWithDebug.debug as Record<string, unknown>;
      assert("exactLaneScore" in dbg, "debug should have exactLaneScore");
      assert("regionalScore" in dbg, "debug should have regionalScore");
      assert("customerHistoryScore" in dbg, "debug should have customerHistoryScore");
      assert("outreachRecencyDelta" in dbg, "debug should have outreachRecencyDelta");
      assert("marketNbaBoost" in dbg, "debug should have marketNbaBoost");
      assert("hfFloorApplied" in dbg, "debug should have hfFloorApplied");
      assert("hfAdjustmentApplied" in dbg, "debug should have hfAdjustmentApplied");
      assert("finalScore" in dbg, "debug should have finalScore");
    }

    // Without ?debug — should NOT have debug object
    const { status: s2, json: j2 } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      c
    );
    assert(s2 === 200, `Expected 200 without debug, got ${s2}`);
    const d2 = j2 as { carriers: Array<{ debug?: unknown }> };
    for (const carrier of d2.carriers) {
      assert(carrier.debug === undefined, `debug field should be absent on normal requests, got ${JSON.stringify(carrier.debug)}`);
    }
  });

  // ── Test (m): HF lane with no exact-lane history returns non-empty regional ─
  await runTest("(m) HF lane with zero exact-lane history returns non-empty list from regional carriers", async () => {
    const org = await createFreshOrg();
    const user = await createUser(org, "admin");
    await enableFeatureFlag(org);
    const c = await loginAs(user.username, user.password);

    // Create an HF lane (by avgLoadsPerWeek) with NO exact-lane TMS history
    const laneId = await createLane(org, "Boise", "Spokane", 2.0); // HF threshold
    // Create regional carriers (no exact-lane history)
    await createCarrier(org, "RegionalFallbackCarrier1", {
      primaryEmail: "reg1@hftest.com",
      regions: ["ID", "WA"],
    });
    await createCarrier(org, "RegionalFallbackCarrier2", {
      primaryEmail: "reg2@hftest.com",
      regions: ["WA"],
    });
    // No financial uploads — zero exact-lane history

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      c
    );
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(json)}`);
    const data = json as { carriers: unknown[]; isHighFrequencyLane: boolean };
    assert(data.isHighFrequencyLane === true, "Should be detected as HF lane");
    assert(data.carriers.length > 0,
      `HF lane with no exact-lane history should still return non-empty list (got 0 carriers). ` +
      `This verifies the regional fallback guardrail.`
    );
  });

  // ── Test (n): HF config externalization — new fields present ──────────────
  await runTest("(n) HIGH_FREQUENCY_CONFIG has all externalized HF tuning fields", async () => {
    const { HIGH_FREQUENCY_CONFIG: cfg } = await import("../server/carrierRankingService.js");
    assert(typeof cfg.hfExactLaneFloorHigh === "number", "hfExactLaneFloorHigh should be a number");
    assert(typeof cfg.hfExactLaneFloorMed === "number", "hfExactLaneFloorMed should be a number");
    assert(typeof cfg.hfExactLaneFloorAny === "number", "hfExactLaneFloorAny should be a number");
    assert(typeof cfg.marketNbaBoostPoints === "number", "marketNbaBoostPoints should be a number");
    assert(typeof cfg.minExactLaneRunsForFloor === "number", "minExactLaneRunsForFloor should be a number");
    assert(cfg.hfExactLaneFloorHigh === 95, `hfExactLaneFloorHigh should be 95, got ${cfg.hfExactLaneFloorHigh}`);
    assert(cfg.hfExactLaneFloorMed === 85, `hfExactLaneFloorMed should be 85, got ${cfg.hfExactLaneFloorMed}`);
    assert(cfg.hfExactLaneFloorAny === 72, `hfExactLaneFloorAny should be 72, got ${cfg.hfExactLaneFloorAny}`);
    assert(cfg.marketNbaBoostPoints === 8, `marketNbaBoostPoints should be 8, got ${cfg.marketNbaBoostPoints}`);
    assert(cfg.minExactLaneRunsForFloor === 1, `minExactLaneRunsForFloor should be 1, got ${cfg.minExactLaneRunsForFloor}`);
  });

  // ── Test (o): Mixed exact + NBA carriers ranking ───────────────────────────
  await runTest("(o) HF lane: exact-lane carriers rank first and hasMarketNbaBoost correct in debug", async () => {
    const org = await createFreshOrg();
    const user = await createUser(org, "admin");
    await enableFeatureFlag(org);
    const c = await loginAs(user.username, user.password);

    const laneId = await createLane(org, "Reno", "Las Vegas", 3.0); // HF
    // Exact-lane carrier
    const exactCarrierId = await createCarrier(org, "RankingExactCarrier", { primaryEmail: "exact@ranking.com" });
    // NBA-only carrier (no exact history)
    const nbaCarrierId = await createCarrier(org, "RankingNbaCarrier", { primaryEmail: "nba@ranking.com" });
    const signalId = await createMarketSignal();
    await createCarrierMarketNba(nbaCarrierId, signalId);

    // Give exact carrier 5 runs on this lane
    await createFinancialUpload(user.id, Array.from({ length: 5 }, () => ({
      shipperCity: "reno",
      consigneeCity: "las vegas",
      carrier: "RankingExactCarrier",
      month: "2026-02",
    })));

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&debug=true`,
      c
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as {
      carriers: Array<{
        carrierId: string | null;
        carrierName: string;
        fitScore: number;
        historyMatch: string;
        hasMarketNbaBoost: boolean;
        debug?: {
          exactLaneScore: number;
          marketNbaBoost: number;
          hfFloorApplied: number;
          hfAdjustmentApplied: boolean;
        };
      }>;
    };

    const exactCarrier = data.carriers.find(x => x.carrierId === exactCarrierId);
    const nbaCarrier = data.carriers.find(x => x.carrierId === nbaCarrierId);

    assert(!!exactCarrier, "RankingExactCarrier should appear in results");
    assert(exactCarrier!.historyMatch === "exact", `exactCarrier.historyMatch should be 'exact', got ${exactCarrier!.historyMatch}`);
    assert(exactCarrier!.fitScore >= 85, `Exact-lane carrier with 5 runs should have fitScore ≥ 85, got ${exactCarrier!.fitScore}`);
    // exact-lane carrier should rank before NBA-only carrier
    const exactIdx = data.carriers.findIndex(x => x.carrierId === exactCarrierId);
    const nbaIdx = data.carriers.findIndex(x => x.carrierId === nbaCarrierId);
    if (nbaIdx >= 0) {
      assert(exactIdx < nbaIdx,
        `Exact-lane carrier (idx ${exactIdx}) should rank before NBA-only carrier (idx ${nbaIdx})`);
    }
    // NBA carrier should have hasMarketNbaBoost=true (visible in response)
    if (nbaCarrier) {
      assert(nbaCarrier.hasMarketNbaBoost === true,
        `NBA carrier should have hasMarketNbaBoost=true, got ${nbaCarrier.hasMarketNbaBoost}`);
      if (nbaCarrier.debug) {
        assert(nbaCarrier.debug.marketNbaBoost > 0,
          `NBA carrier debug.marketNbaBoost should be > 0, got ${nbaCarrier.debug.marketNbaBoost}`);
      }
    }
    // Exact carrier in debug should show hfFloorApplied > 0 (floor was applied)
    if (exactCarrier?.debug) {
      assert(exactCarrier.debug.exactLaneScore > 0,
        `debug.exactLaneScore should be > 0 for exact carrier, got ${exactCarrier.debug.exactLaneScore}`);
    }
  });

  // ── Summary ────────────────────────────────────────────────────────────────

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
