/**
 * Carrier Ranking Consumer v1 — Tests (Task #196)
 *
 * Covers:
 *   (A) Ranking boosts per type:
 *       a1 — Accepted exact lane_preference boosts fitScore relative to baseline
 *       a2 — Accepted region_preference provides boost when region matches lane
 *       a3 — Accepted equipment_capability provides lift when equipment matches
 *       a4 — Fresh accepted capacity_available boosts fitScore
 *       a5 — Fresh accepted capacity_unavailable penalizes fitScore
 *   (B) Historical precedence:
 *       b1 — Carrier with strong exact-lane history outranks carrier with only accepted prefs
 *   (C) Freshness rules:
 *       c1 — Stale capacity_available signal (>21 days) has no effect
 *       c2 — Stale capacity_unavailable signal (>21 days) has no effect
 *   (D) Explanation/debug output:
 *       d1 — acceptedIntelPhrases populated when carrier has matching accepted intel
 *       d2 — debug mode includes all five accepted-intel sub-score fields
 *       d3 — carrierFitExplanation.acceptedIntelPhrases populated on HF lanes
 *   (E) Safety scenarios:
 *       e1 — Pending/rejected suggestions do NOT affect ranking
 *       e2 — Carrier with no accepted intel ranks normally (no crash)
 *       e3 — Caution flags appear for accepted capacity_unavailable, service_risk, price_sensitivity
 *       e4 — Conflicting signals (available + unavailable) do not crash
 *
 * Run with: npx tsx tests/carrier-ranking-accepted-intel.test.ts
 * Requires: dev server running on port 5000
 */

import pg from "pg";
import crypto from "crypto";
import bcrypt from "bcrypt";
import http from "http";
import {
  ACCEPTED_INTEL_CONFIG,
} from "../server/carrierRankingService.js";

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

async function apiGet(path: string, cookie: string): Promise<{ status: number; json: unknown }> {
  const res = await httpRequest({ method: "GET", path, headers: { Cookie: cookie } });
  let json: unknown;
  try { json = JSON.parse(res.body); } catch { json = res.body; }
  return { status: res.status, json };
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

// ── DB helpers ────────────────────────────────────────────────────────────────

async function createFreshOrg(): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO organizations (id, name, slug, created_at) VALUES ($1, $2, $3, $4)`,
    [id, `Intel Test Org ${id.slice(0, 6)}`, `intel-test-${id.slice(0, 8)}`, now]
  );
  track("organizations", id);
  return id;
}

async function createUser(orgId: string): Promise<{ id: string; username: string; password: string }> {
  const id = uid();
  const password = `Pass${id.slice(0, 8)}!`;
  const hash = await bcrypt.hash(password, 10);
  const username = `intel.test.${id.slice(0, 8)}@example.com`;
  const now = new Date().toISOString();
  await q(
    `INSERT INTO users (id, organization_id, username, password, name, role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, orgId, username, hash, `IntelTest ${id.slice(0, 6)}`, "admin", now]
  );
  track("users", id);
  return { id, username, password };
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
  origin: string,
  destination: string,
  avgLoadsPerWeek = 3,
  equipmentType?: string,
): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO recurring_lanes
       (id, org_id, origin, destination, equipment_type, is_eligible, has_preferred_carrier_program,
        eligibility_confidence, avg_loads_per_week, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, true, false, 'medium', $6, $7, $7)`,
    [id, orgId, origin, destination, equipmentType ?? null, avgLoadsPerWeek, now]
  );
  track("recurring_lanes", id);
  return id;
}

async function createCarrier(orgId: string, name: string, options?: {
  primaryEmail?: string | null;
  regions?: string[];
  equipmentTypes?: string[];
  statesServed?: string[];
}): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO carriers (id, org_id, name, primary_email, regions, equipment_types, tags, states_served, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [
      id, orgId, name,
      options?.primaryEmail ?? `${id.slice(0, 6)}@test.com`,
      options?.regions ?? [],
      options?.equipmentTypes ?? [],
      [],
      options?.statesServed ?? [],
      now,
    ]
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
      id, `intel-test-${id.slice(0, 8)}.csv`, now, uploadedBy, rows.length,
      JSON.stringify(rows), JSON.stringify([]), JSON.stringify([]),
      JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]),
    ]
  );
  track("financial_uploads", id);
  return id;
}

async function createSuggestion(
  carrierId: string,
  orgId: string,
  suggestionType: string,
  status: string,
  payload: Record<string, unknown>,
  acceptedDaysAgo?: number,
): Promise<string> {
  const id = uid();
  const acceptedAt = acceptedDaysAgo !== undefined
    ? new Date(Date.now() - acceptedDaysAgo * 24 * 60 * 60 * 1000).toISOString()
    : null;
  const now = new Date().toISOString();
  await q(
    `INSERT INTO carrier_intel_suggestions (
      id, carrier_id, org_id, source_type, suggestion_type, payload,
      confidence_score, status, accepted_at, updated_at, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $10)`,
    [
      id, carrierId, orgId, "email_signal", suggestionType,
      JSON.stringify(payload), 80, status, acceptedAt, now,
    ]
  );
  track("carrier_intel_suggestions", id);
  return id;
}

// ── Test suite ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n=== Carrier Ranking: Accepted Intel Consumer v1 (Task #196) ===\n");

  // ── (A) Ranking boosts per type ──────────────────────────────────────────

  await runTest("(a1) Accepted exact lane_preference boosts fitScore vs. baseline carrier", async () => {
    const orgId = await createFreshOrg();
    const user = await createUser(orgId);
    await enableFeatureFlag(orgId);
    const cookie = await loginAs(user.username, user.password);

    const laneId = await createLane(orgId, "phoenix", "kent");

    // Carrier A: has an accepted exact lane preference matching this lane
    const carrierAId = await createCarrier(orgId, "IntelLaneA", {
      primaryEmail: "lane-a@test.com",
      equipmentTypes: ["Dry Van"],
    });
    await createSuggestion(carrierAId, orgId, "lane_preference", "accepted", {
      origin: "phoenix", destination: "kent",
    }, 5);

    // Carrier B: no accepted intel, same profile otherwise
    await createCarrier(orgId, "BaselineB", {
      primaryEmail: "baseline-b@test.com",
      equipmentTypes: ["Dry Van"],
    });

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&debug=true`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(json)}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number; carrierId: string; debug?: Record<string, unknown> }> };

    const carrierA = data.carriers.find(c => c.carrierId === carrierAId);
    const carrierB = data.carriers.find(c => c.carrierName.toLowerCase() === "baselineb");
    assert(carrierA !== undefined, `IntelLaneA not found (results: ${data.carriers.map(c => c.carrierName).join(", ")})`);
    assert(carrierB !== undefined, `BaselineB not found`);

    // Carrier A should be boosted above the baseline
    assert(
      carrierA.fitScore >= carrierB.fitScore,
      `IntelLaneA (${carrierA.fitScore}) should score >= BaselineB (${carrierB.fitScore})`
    );
    assert(
      (carrierA.debug?.acceptedLanePreferenceScore as number) > 0,
      `Expected acceptedLanePreferenceScore > 0, got ${carrierA.debug?.acceptedLanePreferenceScore}`
    );
  });

  await runTest("(a2) Accepted region_preference provides boost when region matches lane origin", async () => {
    const orgId = await createFreshOrg();
    const user = await createUser(orgId);
    await enableFeatureFlag(orgId);
    const cookie = await loginAs(user.username, user.password);

    // Lane has origin=phoenix; carrier's accepted region_preference covers "az"
    const laneId = await createLane(orgId, "phoenix az", "kent wa");

    const carrierId = await createCarrier(orgId, "RegionPrefCarrier", {
      primaryEmail: "region@test.com",
      regions: ["az", "wa"],
    });
    await createSuggestion(carrierId, orgId, "region_preference", "accepted", {
      region: "az",
    }, 5);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&debug=true`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierId: string; debug?: Record<string, unknown> }> };
    const carrier = data.carriers.find(c => c.carrierId === carrierId);
    assert(carrier !== undefined, "RegionPrefCarrier not found");
    assert(
      (carrier.debug?.acceptedRegionPreferenceScore as number) > 0,
      `Expected region preference boost > 0, got ${carrier.debug?.acceptedRegionPreferenceScore}`
    );
  });

  await runTest("(a3) Accepted equipment_capability provides lift when equipment matches", async () => {
    const orgId = await createFreshOrg();
    const user = await createUser(orgId);
    await enableFeatureFlag(orgId);
    const cookie = await loginAs(user.username, user.password);

    // Lane must have equipment_type set so laneEquipNorm is non-empty
    const laneId = await createLane(orgId, "dallas", "houston", 3, "Dry Van");

    const carrierId = await createCarrier(orgId, "EquipCapCarrier", {
      primaryEmail: "equip@test.com",
      equipmentTypes: ["Dry Van"],
    });
    await createSuggestion(carrierId, orgId, "equipment_capability", "accepted", {
      equipment: "Dry Van",
    }, 5);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&debug=true`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierId: string; debug?: Record<string, unknown> }> };
    const carrier = data.carriers.find(c => c.carrierId === carrierId);
    assert(carrier !== undefined, "EquipCapCarrier not found");
    assert(
      (carrier.debug?.acceptedEquipmentCapabilityScore as number) > 0,
      `Expected equipment capability boost > 0, got ${carrier.debug?.acceptedEquipmentCapabilityScore}`
    );
    assert(
      (carrier.debug?.acceptedEquipmentCapabilityScore as number) <= ACCEPTED_INTEL_CONFIG.acceptedEquipmentCapabilityBoost,
      `Expected equipment capability boost <= ${ACCEPTED_INTEL_CONFIG.acceptedEquipmentCapabilityBoost}`
    );
  });

  await runTest("(a4) Fresh accepted capacity_available boosts fitScore", async () => {
    const orgId = await createFreshOrg();
    const user = await createUser(orgId);
    await enableFeatureFlag(orgId);
    const cookie = await loginAs(user.username, user.password);

    const laneId = await createLane(orgId, "chicago", "detroit");

    // Carrier with fresh capacity available signal
    const carrierWithCapId = await createCarrier(orgId, "CapAvailableCarrier", {
      primaryEmail: "cap-avail@test.com",
    });
    await createSuggestion(carrierWithCapId, orgId, "capacity_available", "accepted", {
      region: "midwest",
    }, 3); // 3 days ago — fresh

    // Carrier without capacity signal
    const carrierNormalId = await createCarrier(orgId, "NormalCapCarrier", {
      primaryEmail: "normal-cap@test.com",
    });

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&debug=true`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierId: string; debug?: Record<string, unknown> }> };

    const withCap = data.carriers.find(c => c.carrierId === carrierWithCapId);
    const withoutCap = data.carriers.find(c => c.carrierId === carrierNormalId);
    assert(withCap !== undefined, "CapAvailableCarrier not found");
    assert(withoutCap !== undefined, "NormalCapCarrier not found");
    assert(
      (withCap.debug?.acceptedCapacityAvailabilityScore as number) > 0,
      `Expected capacity availability boost > 0, got ${withCap.debug?.acceptedCapacityAvailabilityScore}`
    );
    assert(
      (withoutCap.debug?.acceptedCapacityAvailabilityScore as number) === 0,
      `Expected normal carrier to have 0 capacity availability score`
    );
  });

  await runTest("(a5) Fresh accepted capacity_unavailable penalizes fitScore", async () => {
    const orgId = await createFreshOrg();
    const user = await createUser(orgId);
    await enableFeatureFlag(orgId);
    const cookie = await loginAs(user.username, user.password);

    const laneId = await createLane(orgId, "miami", "orlando");

    // Carrier with fresh capacity unavailable signal
    const carrierUnavailId = await createCarrier(orgId, "CapUnavailCarrier", {
      primaryEmail: "cap-unavail@test.com",
    });
    await createSuggestion(carrierUnavailId, orgId, "capacity_unavailable", "accepted", {
      region: "southeast",
    }, 2); // 2 days ago — fresh

    // Baseline carrier with same profile
    const carrierNormalId = await createCarrier(orgId, "NormalNoFlagCarrier", {
      primaryEmail: "normal-noflag@test.com",
    });

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&debug=true`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierId: string; fitScore: number; debug?: Record<string, unknown> }> };

    const unavail = data.carriers.find(c => c.carrierId === carrierUnavailId);
    const normal = data.carriers.find(c => c.carrierId === carrierNormalId);
    assert(unavail !== undefined, "CapUnavailCarrier not found");
    assert(normal !== undefined, "NormalNoFlagCarrier not found");

    assert(
      (unavail.debug?.acceptedCapacitySuppressionPenalty as number) > 0,
      `Expected suppression penalty > 0, got ${unavail.debug?.acceptedCapacitySuppressionPenalty}`
    );
    assert(
      (normal.debug?.acceptedCapacitySuppressionPenalty as number) === 0,
      `Expected normal carrier to have 0 suppression penalty`
    );
    // The unavailable carrier should score no higher than the normal carrier
    assert(
      unavail.fitScore <= normal.fitScore,
      `CapUnavailCarrier (${unavail.fitScore}) should score <= NormalNoFlagCarrier (${normal.fitScore})`
    );
  });

  // ── (B) Historical precedence ────────────────────────────────────────────

  await runTest("(b1) Carrier with strong exact-lane history outranks carrier with only accepted prefs", async () => {
    const orgId = await createFreshOrg();
    const user = await createUser(orgId);
    await enableFeatureFlag(orgId);
    const cookie = await loginAs(user.username, user.password);

    // Lane: chicago → detroit (HF)
    const laneId = await createLane(orgId, "chicago", "detroit", 3);

    // Carrier A: 12 exact-lane TMS loads (strong historical signal)
    await createCarrier(orgId, "HistoricalHeavyCarrier", { primaryEmail: "hist@test.com" });
    const tmsRows = Array.from({ length: 12 }, () => ({
      carrier: "HistoricalHeavyCarrier",
      shipperCity: "chicago",
      consigneeCity: "detroit",
      month: "2026-03",
    }));
    await createFinancialUpload(user.id, tmsRows);

    // Carrier B: no TMS history, but has all five accepted intel types
    const carrierBId = await createCarrier(orgId, "IntelOnlyCarrier", { primaryEmail: "intel-only@test.com" });
    await createSuggestion(carrierBId, orgId, "lane_preference", "accepted", {
      origin: "chicago", destination: "detroit",
    }, 5);
    await createSuggestion(carrierBId, orgId, "region_preference", "accepted", { region: "midwest" }, 5);
    await createSuggestion(carrierBId, orgId, "equipment_capability", "accepted", { equipment: "Dry Van" }, 5);
    await createSuggestion(carrierBId, orgId, "capacity_available", "accepted", { region: "midwest" }, 5);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; carrierId: string; fitScore: number }> };

    const carrierA = data.carriers.find(c => c.carrierName.toLowerCase() === "historicalheavycarrier");
    const carrierB = data.carriers.find(c => c.carrierId === carrierBId);
    assert(carrierA !== undefined, `HistoricalHeavyCarrier not found (results: ${data.carriers.map(c => c.carrierName).join(", ")})`);
    assert(carrierB !== undefined, `IntelOnlyCarrier not found`);

    assert(
      carrierA.fitScore > carrierB.fitScore,
      `Historical carrier (${carrierA.fitScore}) should outrank intel-only carrier (${carrierB.fitScore})`
    );
  });

  // ── (C) Freshness rules ──────────────────────────────────────────────────

  await runTest("(c1) Stale capacity_available signal (>21 days) has no effect on score", async () => {
    const orgId = await createFreshOrg();
    const user = await createUser(orgId);
    await enableFeatureFlag(orgId);
    const cookie = await loginAs(user.username, user.password);

    const laneId = await createLane(orgId, "seattle", "portland");
    const carrierId = await createCarrier(orgId, "StaleAvailCarrier", { primaryEmail: "stale-avail@test.com" });
    // Signal is STALE (beyond freshness window)
    await createSuggestion(carrierId, orgId, "capacity_available", "accepted", { region: "northwest" },
      ACCEPTED_INTEL_CONFIG.acceptedIntelFreshnessDays + 5);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&debug=true`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierId: string; debug?: Record<string, unknown> }> };
    const carrier = data.carriers.find(c => c.carrierId === carrierId);
    assert(carrier !== undefined, "StaleAvailCarrier not found");
    assert(
      (carrier.debug?.acceptedCapacityAvailabilityScore as number) === 0,
      `Stale capacity signal should give 0 boost, got ${carrier.debug?.acceptedCapacityAvailabilityScore}`
    );
  });

  await runTest("(c2) Stale capacity_unavailable signal (>21 days) has no effect on score", async () => {
    const orgId = await createFreshOrg();
    const user = await createUser(orgId);
    await enableFeatureFlag(orgId);
    const cookie = await loginAs(user.username, user.password);

    const laneId = await createLane(orgId, "boston", "hartford");
    const carrierId = await createCarrier(orgId, "StaleUnavailCarrier", { primaryEmail: "stale-unavail@test.com" });
    // Signal is STALE
    await createSuggestion(carrierId, orgId, "capacity_unavailable", "accepted", { region: "northeast" },
      ACCEPTED_INTEL_CONFIG.acceptedIntelFreshnessDays + 5);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&debug=true`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierId: string; debug?: Record<string, unknown> }> };
    const carrier = data.carriers.find(c => c.carrierId === carrierId);
    assert(carrier !== undefined, "StaleUnavailCarrier not found");
    assert(
      (carrier.debug?.acceptedCapacitySuppressionPenalty as number) === 0,
      `Stale unavailable signal should give 0 penalty, got ${carrier.debug?.acceptedCapacitySuppressionPenalty}`
    );
  });

  // ── (D) Explanation/debug output ────────────────────────────────────────

  await runTest("(d1) acceptedIntelPhrases in whyThisCarrier when carrier has accepted intel", async () => {
    const orgId = await createFreshOrg();
    const user = await createUser(orgId);
    await enableFeatureFlag(orgId);
    const cookie = await loginAs(user.username, user.password);

    const laneId = await createLane(orgId, "mesa", "olympia");
    const carrierId = await createCarrier(orgId, "PhrasesCarrier", {
      primaryEmail: "phrases@test.com",
      regions: ["az", "wa"],
    });
    await createSuggestion(carrierId, orgId, "lane_preference", "accepted", {
      origin: "mesa", destination: "olympia",
    }, 3);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as {
      carriers: Array<{
        carrierId: string;
        whyThisCarrier?: { acceptedIntelPhrases?: string[] }
      }>
    };
    const carrier = data.carriers.find(c => c.carrierId === carrierId);
    assert(carrier !== undefined, "PhrasesCarrier not found");
    const phrases = carrier.whyThisCarrier?.acceptedIntelPhrases;
    assert(
      Array.isArray(phrases) && phrases.length > 0,
      `Expected acceptedIntelPhrases array in whyThisCarrier, got: ${JSON.stringify(carrier.whyThisCarrier)}`
    );
    // Must reference "accepted" or "preference" — not historical execution language
    assert(
      phrases!.some(p => p.toLowerCase().includes("accept") || p.toLowerCase().includes("preference") || p.toLowerCase().includes("intel")),
      `Expected phrases to reference 'accepted'/'preference'/'intel', got: ${JSON.stringify(phrases)}`
    );
    // Must not use execution/history language
    assert(
      !phrases!.some(p => p.toLowerCase().includes("previously ran") || p.toLowerCase().includes("executed")),
      `Phrases must not use execution history language, got: ${JSON.stringify(phrases)}`
    );
  });

  await runTest("(d2) debug=true includes all five accepted-intel sub-score fields", async () => {
    const orgId = await createFreshOrg();
    const user = await createUser(orgId);
    await enableFeatureFlag(orgId);
    const cookie = await loginAs(user.username, user.password);

    const laneId = await createLane(orgId, "denver", "salt lake city");
    const carrierId = await createCarrier(orgId, "DebugScoresCarrier", {
      primaryEmail: "debug-scores@test.com",
    });

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&debug=true`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierId: string; debug?: Record<string, unknown> }> };
    const carrier = data.carriers.find(c => c.carrierId === carrierId);
    assert(carrier !== undefined, "DebugScoresCarrier not found");
    assert(carrier.debug !== undefined, "Expected debug object with debug=true");

    const debugKeys = ["acceptedLanePreferenceScore", "acceptedRegionPreferenceScore",
      "acceptedEquipmentCapabilityScore", "acceptedCapacityAvailabilityScore",
      "acceptedCapacitySuppressionPenalty"];
    for (const key of debugKeys) {
      assert(key in carrier.debug!, `Missing debug field: ${key}`);
      assert(typeof carrier.debug![key] === "number", `Expected number for ${key}, got ${typeof carrier.debug![key]}`);
    }
  });

  await runTest("(d3) carrierFitExplanation.acceptedIntelPhrases populated on HF lanes", async () => {
    const orgId = await createFreshOrg();
    const user = await createUser(orgId);
    await enableFeatureFlag(orgId);
    const cookie = await loginAs(user.username, user.password);

    // HF lane: avgLoadsPerWeek = 3
    const laneId = await createLane(orgId, "flagstaff", "bellevue", 3);
    const carrierId = await createCarrier(orgId, "HFIntelCarrier", {
      primaryEmail: "hf-intel@test.com",
      regions: ["az", "wa"],
    });
    await createSuggestion(carrierId, orgId, "lane_preference", "accepted", {
      origin: "flagstaff", destination: "bellevue",
    }, 3);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as {
      isHighFrequencyLane: boolean;
      carriers: Array<{
        carrierId: string;
        carrierFitExplanation?: { acceptedIntelPhrases?: string[] } | null;
      }>
    };
    assert(data.isHighFrequencyLane === true, `Expected HF lane, got isHighFrequencyLane=${data.isHighFrequencyLane}`);

    const carrier = data.carriers.find(c => c.carrierId === carrierId);
    assert(carrier !== undefined, "HFIntelCarrier not found");
    assert(
      carrier.carrierFitExplanation !== null && carrier.carrierFitExplanation !== undefined,
      "Expected carrierFitExplanation to be non-null on HF lane"
    );
    assert(
      Array.isArray(carrier.carrierFitExplanation?.acceptedIntelPhrases) &&
      carrier.carrierFitExplanation!.acceptedIntelPhrases!.length > 0,
      `Expected carrierFitExplanation.acceptedIntelPhrases to be populated`
    );
  });

  // ── (E) Safety scenarios ─────────────────────────────────────────────────

  await runTest("(e1) Pending/rejected suggestions do NOT affect ranking scores", async () => {
    const orgId = await createFreshOrg();
    const user = await createUser(orgId);
    await enableFeatureFlag(orgId);
    const cookie = await loginAs(user.username, user.password);

    const laneId = await createLane(orgId, "kansas city", "st louis");

    // Carrier P: has pending lane preference
    const carrierPId = await createCarrier(orgId, "PendingSuggCarrier", {
      primaryEmail: "pending-sugg@test.com",
    });
    await createSuggestion(carrierPId, orgId, "lane_preference", "pending", {
      origin: "kansas city", destination: "st louis",
    }, 3);

    // Carrier R: has rejected lane preference
    const carrierRId = await createCarrier(orgId, "RejectedSuggCarrier", {
      primaryEmail: "rejected-sugg@test.com",
    });
    await createSuggestion(carrierRId, orgId, "lane_preference", "rejected", {
      origin: "kansas city", destination: "st louis",
    }, 3);

    // Carrier B: baseline with no intel
    const carrierBId = await createCarrier(orgId, "BaselineIntelCarrier", {
      primaryEmail: "baseline-intel@test.com",
    });

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&debug=true`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierId: string; fitScore: number; debug?: Record<string, unknown> }> };

    const pending = data.carriers.find(c => c.carrierId === carrierPId);
    const rejected = data.carriers.find(c => c.carrierId === carrierRId);
    const baseline = data.carriers.find(c => c.carrierId === carrierBId);

    assert(pending !== undefined, "PendingSuggCarrier not found");
    assert(rejected !== undefined, "RejectedSuggCarrier not found");
    assert(baseline !== undefined, "BaselineIntelCarrier not found");

    // Both non-accepted carriers should have zero accepted-intel scores
    assert(
      (pending.debug?.acceptedLanePreferenceScore as number) === 0,
      `Pending carrier should have 0 lane pref score, got ${pending.debug?.acceptedLanePreferenceScore}`
    );
    assert(
      (rejected.debug?.acceptedLanePreferenceScore as number) === 0,
      `Rejected carrier should have 0 lane pref score, got ${rejected.debug?.acceptedLanePreferenceScore}`
    );
    // Neither pending nor rejected should be boosted above baseline
    assert(
      pending.fitScore <= baseline.fitScore + 1,
      `Pending (${pending.fitScore}) should not outrank baseline (${baseline.fitScore})`
    );
    assert(
      rejected.fitScore <= baseline.fitScore + 1,
      `Rejected (${rejected.fitScore}) should not outrank baseline (${baseline.fitScore})`
    );
  });

  await runTest("(e2) Carrier with no accepted intel ranks normally (no crash, all sub-scores zero)", async () => {
    const orgId = await createFreshOrg();
    const user = await createUser(orgId);
    await enableFeatureFlag(orgId);
    const cookie = await loginAs(user.username, user.password);

    const laneId = await createLane(orgId, "minneapolis", "milwaukee");
    const carrierId = await createCarrier(orgId, "NoIntelCarrier", {
      primaryEmail: "no-intel@test.com",
    });

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&debug=true`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(json)}`);
    const data = json as { carriers: Array<{ carrierId: string; debug?: Record<string, unknown> }> };
    const carrier = data.carriers.find(c => c.carrierId === carrierId);
    assert(carrier !== undefined, "NoIntelCarrier not found");

    // All intel sub-scores should be exactly 0
    const debugKeys = [
      "acceptedLanePreferenceScore", "acceptedRegionPreferenceScore",
      "acceptedEquipmentCapabilityScore", "acceptedCapacityAvailabilityScore",
      "acceptedCapacitySuppressionPenalty",
    ];
    for (const key of debugKeys) {
      assert(
        carrier.debug?.[key] === 0,
        `Expected ${key} = 0 for carrier with no intel, got ${carrier.debug?.[key]}`
      );
    }
  });

  await runTest("(e3) Caution flags present for accepted capacity_unavailable, service_risk, price_sensitivity", async () => {
    const orgId = await createFreshOrg();
    const user = await createUser(orgId);
    await enableFeatureFlag(orgId);
    const cookie = await loginAs(user.username, user.password);

    const laneId = await createLane(orgId, "atlanta", "nashville");
    const carrierId = await createCarrier(orgId, "CautionFlagsCarrier", {
      primaryEmail: "caution@test.com",
    });

    // Add all three caution signals (all fresh)
    await createSuggestion(carrierId, orgId, "capacity_unavailable", "accepted", { region: "southeast" }, 5);
    await createSuggestion(carrierId, orgId, "service_risk", "accepted", { issueType: "late_delivery" }, 5);
    await createSuggestion(carrierId, orgId, "price_sensitivity", "accepted", { rate: "above_market" }, 5);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as {
      carriers: Array<{
        carrierId: string;
        cautionFlags?: {
          hasAcceptedCapacityUnavailable?: boolean;
          hasAcceptedServiceRisk?: boolean;
          hasAcceptedPriceSensitivity?: boolean;
        }
      }>
    };
    const carrier = data.carriers.find(c => c.carrierId === carrierId);
    assert(carrier !== undefined, "CautionFlagsCarrier not found");
    assert(carrier.cautionFlags !== undefined, "Expected cautionFlags to be present");
    assert(carrier.cautionFlags!.hasAcceptedCapacityUnavailable === true,
      `Expected hasAcceptedCapacityUnavailable=true, got ${carrier.cautionFlags!.hasAcceptedCapacityUnavailable}`);
    assert(carrier.cautionFlags!.hasAcceptedServiceRisk === true,
      `Expected hasAcceptedServiceRisk=true, got ${carrier.cautionFlags!.hasAcceptedServiceRisk}`);
    assert(carrier.cautionFlags!.hasAcceptedPriceSensitivity === true,
      `Expected hasAcceptedPriceSensitivity=true, got ${carrier.cautionFlags!.hasAcceptedPriceSensitivity}`);
  });

  await runTest("(e4) Conflicting signals: both available+unavailable fresh → both scores applied", async () => {
    const orgId = await createFreshOrg();
    const user = await createUser(orgId);
    await enableFeatureFlag(orgId);
    const cookie = await loginAs(user.username, user.password);

    const laneId = await createLane(orgId, "phoenix", "albuquerque");
    const carrierId = await createCarrier(orgId, "ConflictSignalCarrier", {
      primaryEmail: "conflict@test.com",
    });

    // Both available and unavailable signals — both fresh
    await createSuggestion(carrierId, orgId, "capacity_available", "accepted", { region: "southwest" }, 3);
    await createSuggestion(carrierId, orgId, "capacity_unavailable", "accepted", { region: "southwest" }, 3);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&debug=true`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(json)}`);
    const data = json as { carriers: Array<{ carrierId: string; debug?: Record<string, unknown> }> };
    const carrier = data.carriers.find(c => c.carrierId === carrierId);
    assert(carrier !== undefined, "ConflictSignalCarrier not found");

    // Both scores must be present AND non-zero — unavailable penalty must not be suppressed
    // by a competing available signal (the fix for the early-break bug)
    assert(
      (carrier.debug?.acceptedCapacityAvailabilityScore as number) > 0,
      `Expected capacity availability score > 0 when fresh available signal exists, got ${carrier.debug?.acceptedCapacityAvailabilityScore}`
    );
    assert(
      (carrier.debug?.acceptedCapacitySuppressionPenalty as number) > 0,
      `Expected suppression penalty > 0 when fresh unavailable signal exists (even if available also exists), got ${carrier.debug?.acceptedCapacitySuppressionPenalty}`
    );
  });

  // ── Summary ──────────────────────────────────────────────────────────────────

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n=== Results: ${passed}/${results.length} passed (${failed} failed) ===\n`);

  if (failed > 0) {
    console.log("Failed tests:");
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  ✗ ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}

async function cleanup(): Promise<void> {
  // Ordered by FK dependency — child tables first
  const order = [
    "carrier_intel_suggestions",
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
  await pool.end();
}

main()
  .catch(err => {
    console.error("Unexpected error:", err);
    process.exit(1);
  })
  .finally(cleanup);
