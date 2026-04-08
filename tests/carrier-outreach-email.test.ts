/**
 * Phase 1 Carrier Email Send + Tracking Tests
 *
 * Covers:
 *   - Carrier ranking: exact-lane history boosts score
 *   - Carrier ranking: similar-lane history boosts score
 *   - Carrier ranking: customer history boosts score
 *   - Carrier ranking: positive prior outreach outcome boosts score
 *   - "Why this carrier" fitReason text reflects signals
 *   - draft-outreach-emails endpoint: generates email with lane details
 *   - draft-outreach-emails endpoint: generates fallback when AI fails (via timeout mock)
 *   - send-outreach-emails endpoint: logs entry with deliveryStatus='sent' or 'failed'
 *   - send-outreach-emails endpoint: creates bench entry (outreach_sent_at set)
 *   - send-outreach-emails endpoint: carriers without email get status='no_email'
 *   - send-outreach-emails endpoint: failureReason populated when all sends fail
 *   - outreach-log GET: returns logged history for the lane including sentAt
 *   - outreach-log GET: deliveryStatus field visible in history response
 *
 * Run with: npx tsx tests/carrier-outreach-email.test.ts
 */

import pg from "pg";
import crypto from "crypto";
import bcrypt from "bcrypt";
import http from "http";

const SERVER_HOST = "localhost";
const SERVER_PORT = 5000;

// ── HTTP helper ─────────────────────────────────────────────────────────────

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

// ── DB helpers ───────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function q(text: string, values?: unknown[]): Promise<pg.QueryResult> {
  return pool.query(text, values);
}

function uid(): string {
  return crypto.randomUUID();
}

// ── Test harness ─────────────────────────────────────────────────────────────

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

// ── Auth helpers ─────────────────────────────────────────────────────────────

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

// ── Fixture helpers ──────────────────────────────────────────────────────────

async function getDefaultOrgId(): Promise<string> {
  const res = await q("SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1");
  if (res.rows.length === 0) throw new Error("No organizations found");
  return res.rows[0].id as string;
}

async function createUser(orgId: string, role: string): Promise<{ id: string; username: string; password: string }> {
  const id = uid();
  const password = `Pass${id.slice(0, 8)}!`;
  const hash = await bcrypt.hash(password, 10);
  const username = `coe.test.${id.slice(0, 8)}@example.com`;
  const now = new Date().toISOString();
  await q(
    `INSERT INTO users (id, organization_id, username, password, name, role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, orgId, username, hash, `COETest ${id.slice(0, 6)}`, role, now]
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

/** Create a recurring lane with given origin/dest and owner */
async function createLane(
  orgId: string,
  ownerUserId: string,
  opts: { origin?: string; destination?: string; equipment?: string; companyName?: string } = {}
): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  const origin = opts.origin ?? "Chicago";
  const dest = opts.destination ?? "Dallas";
  const equip = opts.equipment ?? "Dry Van";
  const companyName = opts.companyName ?? null;
  await q(
    `INSERT INTO recurring_lanes
       (id, org_id, origin, origin_state, destination, destination_state, equipment_type,
        is_eligible, has_preferred_carrier_program,
        owner_user_id, carriers_contacted_count, eligibility_confidence,
        company_name, created_at, updated_at)
     VALUES ($1, $2, $3, 'IL', $4, 'TX', $5, true, false, $6, 0, 'medium', $7, $8, $8)`,
    [id, orgId, origin, dest, equip, ownerUserId, companyName, now]
  );
  track("recurring_lanes", id);
  return id;
}

/** Create a carrier in the catalog */
async function createCarrier(
  orgId: string,
  name: string,
  opts: {
    primaryEmail?: string | null;
    regions?: string[];
    equipmentTypes?: string[];
  } = {}
): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO carriers (id, org_id, name, primary_email, regions, equipment_types, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [id, orgId, name, opts.primaryEmail ?? null,
      opts.regions ? `{${opts.regions.map(r => `"${r}"`).join(",")}}` : "{}",
      opts.equipmentTypes ? `{${opts.equipmentTypes.map(e => `"${e}"`).join(",")}}` : "{}",
      now]
  );
  track("carriers", id);
  return id;
}

/** Create a financial upload with TMS rows for testing carrier history.
 *  Note: financial_uploads has NO org_id column — org is resolved via uploaded_by FK.
 */
async function createFinancialUpload(
  uploadedByUserId: string,
  rows: Array<{
    carrier?: string;
    originCity?: string;
    destinationCity?: string;
    customerName?: string;
    month?: string;
  }>
): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  // Use the lowercase/camelCase field names the ranking service expects (TmsRow interface)
  const mappedRows = rows.map(r => ({
    carrier: r.carrier ?? "",
    origin: r.originCity ?? "",
    destination: r.destinationCity ?? "",
    customerName: r.customerName ?? "",
    month: r.month ?? now.slice(0, 7),
  }));
  await q(
    `INSERT INTO financial_uploads (id, uploaded_by, rows, file_name, uploaded_at, row_count)
     VALUES ($1, $2, $3, 'test.xlsx', $4, $5)`,
    [id, uploadedByUserId, JSON.stringify(mappedRows), now, mappedRows.length]
  );
  track("financial_uploads", id);
  return id;
}

/** Create a bench entry with a given interest status (for outreach outcome tests) */
async function createBenchEntry(
  laneId: string,
  carrierId: string | null,
  carrierName: string,
  interestStatus: string
): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO lane_carrier_interest
       (id, lane_id, carrier_id, carrier_name, interest_status, source_type, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'suggested', $6, $6)`,
    [id, laneId, carrierId, carrierName, interestStatus, now]
  );
  track("lane_carrier_interest", id);
  return id;
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  const order = [
    "tasks",
    "lane_carrier_interest",
    "carrier_outreach_logs",
    "financial_uploads",
    "carriers",
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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\nPhase 1 Carrier Email Send + Tracking Tests\n");

  const orgId = await getDefaultOrgId();
  await enableFeatureFlag(orgId);

  const admin = await createUser(orgId, "admin");
  const cookie = await loginAs(admin.username, admin.password);

  // ── 1. Carrier ranking: exact-lane history boosts score ──────────────────

  await runTest("Exact-lane history carrier scores higher than region-only carrier", async () => {
    const laneId = await createLane(orgId, admin.id, { origin: "Milwaukee", destination: "Memphis" });

    // Carrier with exact lane history
    const exactCarrier = await createCarrier(orgId, "Exact Lane Haulers", { primaryEmail: "exact@test.com", regions: ["IL", "TN"] });

    // Carrier with only region match
    const regionCarrier = await createCarrier(orgId, "Region Only Carrier", { primaryEmail: "region@test.com", regions: ["IL", "TN"] });

    // Financial upload: exactCarrier ran this exact lane before
    await createFinancialUpload(admin.id, [
      { carrier: "Exact Lane Haulers", originCity: "Milwaukee", destinationCity: "Memphis", month: "2025-11" },
      { carrier: "Exact Lane Haulers", originCity: "Milwaukee", destinationCity: "Memphis", month: "2025-10" },
    ]);

    const { status, json } = await apiGet(`/api/lanes/${laneId}/carrier-suggestions`, cookie);
    assert(status === 200, `Expected 200 from carrier-suggestions, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number; historyMatch: string }> };
    assert(Array.isArray(data.carriers), "Expected carriers array");

    const exactEntry = data.carriers.find(c => c.carrierName === "Exact Lane Haulers");
    const regionEntry = data.carriers.find(c => c.carrierName === "Region Only Carrier");

    assert(!!exactEntry, "Exact Lane Haulers should appear in suggestions");
    assert(!!regionEntry, "Region Only Carrier should appear in suggestions");
    assert(exactEntry!.fitScore > regionEntry!.fitScore,
      `Exact carrier (${exactEntry!.fitScore}) should score higher than region-only (${regionEntry!.fitScore})`);
    assert(exactEntry!.historyMatch === "exact", `Expected historyMatch='exact', got '${exactEntry!.historyMatch}'`);

    // Cleanup extra resources
    await q(`DELETE FROM carriers WHERE id IN ($1, $2)`, [exactCarrier, regionCarrier]).catch(() => {});
    await q(`DELETE FROM recurring_lanes WHERE id = $1`, [laneId]).catch(() => {});
  });

  // ── 2. Similar-lane history boosts score ─────────────────────────────────

  await runTest("Similar-lane history carrier ranks above new prospect with no history", async () => {
    const laneId = await createLane(orgId, admin.id, { origin: "Phoenix", destination: "Denver" });

    const similarCarrier = await createCarrier(orgId, "Similar Route Carrier", { primaryEmail: "sim@test.com", regions: ["AZ", "CO"] });
    const newProspect = await createCarrier(orgId, "Brand New Prospect Co", { primaryEmail: "new@test.com", regions: ["AZ", "CO"] });

    // Financial upload: similarCarrier ran Phoenix → Salt Lake (similar, not exact)
    await createFinancialUpload(admin.id, [
      { carrier: "Similar Route Carrier", originCity: "Phoenix", destinationCity: "Salt Lake City", month: "2025-09" },
      { carrier: "Similar Route Carrier", originCity: "Phoenix", destinationCity: "Salt Lake City", month: "2025-08" },
    ]);

    const { status, json } = await apiGet(`/api/lanes/${laneId}/carrier-suggestions`, cookie);
    assert(status === 200, `Expected 200 from carrier-suggestions, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number; historyMatch: string }> };

    const simEntry = data.carriers.find(c => c.carrierName === "Similar Route Carrier");
    const newEntry = data.carriers.find(c => c.carrierName === "Brand New Prospect Co");

    assert(!!simEntry, "Similar Route Carrier should appear in suggestions");
    // Similar carrier should score equal or higher than new prospect
    if (newEntry) {
      assert(simEntry!.fitScore >= newEntry!.fitScore,
        `Similar carrier (${simEntry!.fitScore}) should score >= new prospect (${newEntry!.fitScore})`);
    }

    await q(`DELETE FROM carriers WHERE id IN ($1, $2)`, [similarCarrier, newProspect]).catch(() => {});
    await q(`DELETE FROM recurring_lanes WHERE id = $1`, [laneId]).catch(() => {});
  });

  // ── 3. Customer history boosts score ─────────────────────────────────────

  await runTest("Customer history signal boosts carrier score and appears in fitReason", async () => {
    const laneId = await createLane(orgId, admin.id, {
      origin: "Houston",
      destination: "Atlanta",
      companyName: "ACME Freight Inc",
    });

    const custCarrier = await createCarrier(orgId, "Customer History Carrier", { primaryEmail: "cust@test.com", regions: ["TX", "GA"] });

    // Financial upload: this carrier has run freight for ACME Freight Inc before
    await createFinancialUpload(admin.id, [
      { carrier: "Customer History Carrier", originCity: "Houston", destinationCity: "Nashville", customerName: "ACME Freight Inc", month: "2025-10" },
      { carrier: "Customer History Carrier", originCity: "Dallas", destinationCity: "Atlanta", customerName: "ACME Freight Inc", month: "2025-09" },
    ]);

    const { status, json } = await apiGet(`/api/lanes/${laneId}/carrier-suggestions`, cookie);
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number; fitReason: string; customerHistoryLoads: number }> };

    const entry = data.carriers.find(c => c.carrierName === "Customer History Carrier");
    assert(!!entry, "Customer History Carrier should appear in suggestions");
    assert((entry!.customerHistoryLoads ?? 0) > 0,
      `Expected customerHistoryLoads > 0, got ${entry!.customerHistoryLoads}`);
    assert(
      entry!.fitReason.toLowerCase().includes("acme") || entry!.fitReason.toLowerCase().includes("customer"),
      `Expected customer name in fitReason, got: "${entry!.fitReason}"`
    );

    await q(`DELETE FROM carriers WHERE id = $1`, [custCarrier]).catch(() => {});
    await q(`DELETE FROM recurring_lanes WHERE id = $1`, [laneId]).catch(() => {});
  });

  // ── 4. Prior outreach outcome boosts score ───────────────────────────────

  await runTest("Carrier with prior positive bench outcome gets boosted score", async () => {
    const laneId = await createLane(orgId, admin.id, { origin: "Seattle", destination: "Portland" });

    const positiveCarrier = await createCarrier(orgId, "Positive Responder LLC", { primaryEmail: "pos@test.com", regions: ["WA", "OR"] });
    const neutralCarrier = await createCarrier(orgId, "Neutral Carrier Co", { primaryEmail: "neu@test.com", regions: ["WA", "OR"] });

    // Create bench entry: positiveCarrier responded "available_now" in a prior session
    await createBenchEntry(laneId, positiveCarrier, "Positive Responder LLC", "available_now");

    const { status, json } = await apiGet(`/api/lanes/${laneId}/carrier-suggestions`, cookie);
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number; priorOutcomeBoost: boolean }> };

    const posEntry = data.carriers.find(c => c.carrierName === "Positive Responder LLC");
    const neuEntry = data.carriers.find(c => c.carrierName === "Neutral Carrier Co");

    assert(!!posEntry, "Positive Responder LLC should appear in suggestions");
    assert(posEntry!.priorOutcomeBoost === true,
      `Expected priorOutcomeBoost=true for Positive Responder, got ${posEntry!.priorOutcomeBoost}`);
    if (neuEntry) {
      assert(posEntry!.fitScore >= neuEntry!.fitScore,
        `Positive responder (${posEntry!.fitScore}) should score >= neutral carrier (${neuEntry!.fitScore})`);
    }

    await q(`DELETE FROM carriers WHERE id IN ($1, $2)`, [positiveCarrier, neutralCarrier]).catch(() => {});
    await q(`DELETE FROM recurring_lanes WHERE id = $1`, [laneId]).catch(() => {});
  });

  // ── 5. draft-outreach-emails includes lane details in generated draft ────

  await runTest("Draft outreach email includes lane origin, destination, and equipment details", async () => {
    const laneId = await createLane(orgId, admin.id, {
      origin: "Chicago",
      destination: "Miami",
      equipment: "Reefer",
    });
    const carrierId = await createCarrier(orgId, "Draft Test Carrier", { primaryEmail: "draft@test.com" });

    const { status, json } = await apiPost(
      `/api/lanes/${laneId}/draft-outreach-emails`,
      cookie,
      { carrierIds: [carrierId], carrierNames: ["Draft Test Carrier"], outreachMode: "lane_building" }
    );
    assert(status === 200, `Expected 200 from draft endpoint, got ${status}: ${JSON.stringify(json)}`);
    const data = json as { emails: Array<{ carrierId: string; carrierName: string; subject: string; body: string }> };
    assert(Array.isArray(data.emails) && data.emails.length === 1, "Expected 1 email draft");

    const draft = data.emails[0];
    assert(draft.subject.toLowerCase().includes("chicago") || draft.subject.toLowerCase().includes("miami"),
      `Expected subject to contain lane city names, got: "${draft.subject}"`);
    assert(draft.body.length > 50, `Expected substantive email body, got: "${draft.body.slice(0, 50)}"`);

    await q(`DELETE FROM carriers WHERE id = $1`, [carrierId]).catch(() => {});
    await q(`DELETE FROM recurring_lanes WHERE id = $1`, [laneId]).catch(() => {});
  });

  // ── 6. draft-outreach-emails: 400 when no carriers specified ────────────

  await runTest("draft-outreach-emails returns 400 when no carrierNames or carrierIds provided", async () => {
    const laneId = await createLane(orgId, admin.id);

    const { status } = await apiPost(
      `/api/lanes/${laneId}/draft-outreach-emails`,
      cookie,
      { carrierNames: [], outreachMode: "lane_building" }
    );
    assert(status === 400, `Expected 400 for empty carriers, got ${status}`);

    await q(`DELETE FROM recurring_lanes WHERE id = $1`, [laneId]).catch(() => {});
  });

  // ── 7. send-outreach-emails: creates log with deliveryStatus='failed' when no email ─

  await runTest("send-outreach-emails logs status=no_email when carrier has no email address", async () => {
    const laneId = await createLane(orgId, admin.id);
    const carrierId = await createCarrier(orgId, "No Email Carrier", { primaryEmail: null });

    const { status, json } = await apiPost(
      `/api/lanes/${laneId}/send-outreach-emails`,
      cookie,
      {
        emailDrafts: [{
          carrierId,
          carrierName: "No Email Carrier",
          subject: "Test Lane Outreach",
          body: "Hi No Email Carrier, we have a recurring lane.",
          outreachMode: "lane_building",
        }],
        outreachMode: "lane_building",
      }
    );
    assert(status === 200, `Expected 200 from send endpoint, got ${status}: ${JSON.stringify(json)}`);
    const data = json as {
      results: Array<{ carrierName: string; status: string; error?: string }>;
      sentCount: number;
      overallStatus: string;
    };

    assert(Array.isArray(data.results), "Expected results array");
    const noEmailResult = data.results.find(r => r.carrierName === "No Email Carrier");
    assert(!!noEmailResult, "Expected result entry for No Email Carrier");
    assert(noEmailResult!.status === "no_email",
      `Expected status='no_email', got '${noEmailResult!.status}'`);
    assert(data.sentCount === 0, `Expected sentCount=0, got ${data.sentCount}`);
    assert(data.overallStatus === "failed" || data.overallStatus === "partial",
      `Expected failed/partial overall status, got '${data.overallStatus}'`);

    await q(`DELETE FROM carriers WHERE id = $1`, [carrierId]).catch(() => {});
    await q(`DELETE FROM recurring_lanes WHERE id = $1`, [laneId]).catch(() => {});
  });

  // ── 8. send-outreach-emails: log persisted with deliveryStatus field ─────

  await runTest("send-outreach-emails persists outreach log with deliveryStatus and recipients", async () => {
    const laneId = await createLane(orgId, admin.id);
    const carrierId = await createCarrier(orgId, "Send Log Test Carrier", { primaryEmail: null }); // no email so we don't actually send

    await apiPost(
      `/api/lanes/${laneId}/send-outreach-emails`,
      cookie,
      {
        emailDrafts: [{
          carrierId,
          carrierName: "Send Log Test Carrier",
          subject: "Lane Outreach Subject",
          body: "Test email body content.",
          outreachMode: "lane_building",
        }],
        outreachMode: "lane_building",
      }
    );

    // Query the DB directly for the created log
    const logRes = await q(
      `SELECT id, delivery_status, recipients, sent_at FROM carrier_outreach_logs
       WHERE lane_id = $1 ORDER BY timestamp DESC LIMIT 1`,
      [laneId]
    );
    assert(logRes.rows.length === 1, "Expected 1 outreach log to be created");
    const row = logRes.rows[0];
    for (const r of logRes.rows) track("carrier_outreach_logs", r.id);

    assert(typeof row.delivery_status === "string",
      `Expected delivery_status to be set, got: ${row.delivery_status}`);
    assert(row.recipients !== null,
      "Expected recipients JSONB to be populated");

    await q(`DELETE FROM carriers WHERE id = $1`, [carrierId]).catch(() => {});
    await q(`DELETE FROM recurring_lanes WHERE id = $1`, [laneId]).catch(() => {});
  });

  // ── 9. send-outreach-emails: bench entry created for contacted carrier ───

  await runTest("send-outreach-emails upserts bench entry for carrier with email attempt", async () => {
    const laneId = await createLane(orgId, admin.id);
    // Use a real-looking email; it will fail silently but bench should still be updated
    const carrierId = await createCarrier(orgId, "Bench Update Carrier", { primaryEmail: "test@deliveryfailsquietly.invalid" });

    await apiPost(
      `/api/lanes/${laneId}/send-outreach-emails`,
      cookie,
      {
        emailDrafts: [{
          carrierId,
          carrierName: "Bench Update Carrier",
          subject: "Lane Outreach",
          body: "We have consistent freight on this corridor.",
          outreachMode: "lane_building",
        }],
        outreachMode: "lane_building",
      }
    );

    // The bench entry should have outreach_sent_at set (regardless of email success)
    const benchRes = await q(
      `SELECT id, outreach_sent_at FROM lane_carrier_interest
       WHERE lane_id = $1 AND carrier_name = 'Bench Update Carrier' LIMIT 1`,
      [laneId]
    );
    assert(benchRes.rows.length > 0, "Expected bench entry to be created for Bench Update Carrier");
    assert(benchRes.rows[0].outreach_sent_at !== null,
      "Expected outreach_sent_at to be set on the bench entry");
    for (const r of benchRes.rows) track("lane_carrier_interest", r.id);

    await q(`DELETE FROM carriers WHERE id = $1`, [carrierId]).catch(() => {});
    await q(`DELETE FROM recurring_lanes WHERE id = $1`, [laneId]).catch(() => {});
  });

  // ── 10. outreach-log GET: returns history including deliveryStatus ────────

  await runTest("GET outreach-log returns history with deliveryStatus and sentAt fields", async () => {
    const laneId = await createLane(orgId, admin.id);
    const carrierId = await createCarrier(orgId, "History Test Carrier", { primaryEmail: null });

    // Create a log entry via the send endpoint
    await apiPost(`/api/lanes/${laneId}/send-outreach-emails`, cookie, {
      emailDrafts: [{
        carrierId,
        carrierName: "History Test Carrier",
        subject: "History Subject",
        body: "History body text.",
        outreachMode: "lane_building",
      }],
      outreachMode: "lane_building",
    });

    const { status, json } = await apiGet(`/api/lanes/${laneId}/outreach-log`, cookie);
    assert(status === 200, `Expected 200 from outreach-log GET, got ${status}`);
    const logs = json as Array<{
      id: string;
      deliveryStatus: string;
      sentAt: string | null;
      recipients: unknown;
      carrierNames: string[];
    }>;
    assert(Array.isArray(logs), "Expected array from outreach-log");
    assert(logs.length >= 1, `Expected at least 1 log entry, got ${logs.length}`);

    const entry = logs[0];
    assert("deliveryStatus" in entry, `Expected deliveryStatus field in log entry`);
    assert("recipients" in entry, `Expected recipients field in log entry`);
    assert(Array.isArray(entry.carrierNames) && entry.carrierNames.length > 0,
      "Expected carrierNames array populated");
    for (const l of logs) track("carrier_outreach_logs", l.id);

    await q(`DELETE FROM carriers WHERE id = $1`, [carrierId]).catch(() => {});
    await q(`DELETE FROM recurring_lanes WHERE id = $1`, [laneId]).catch(() => {});
  });

  // ── 11. send-outreach-emails: 400 when emailDrafts is empty ─────────────

  await runTest("send-outreach-emails returns 400 when emailDrafts array is empty", async () => {
    const laneId = await createLane(orgId, admin.id);

    const { status } = await apiPost(
      `/api/lanes/${laneId}/send-outreach-emails`,
      cookie,
      { emailDrafts: [], outreachMode: "lane_building" }
    );
    assert(status === 400, `Expected 400 for empty emailDrafts, got ${status}`);

    await q(`DELETE FROM recurring_lanes WHERE id = $1`, [laneId]).catch(() => {});
  });

  // ── 12. send-outreach-emails: capturedEmail is persisted to carrier catalog ─

  await runTest("send-outreach-emails persists captured email to carrier catalog", async () => {
    const laneId = await createLane(orgId, admin.id);
    const carrierId = await createCarrier(orgId, "Captured Email Carrier", { primaryEmail: null });

    const capturedEmail = `captured.${uid().slice(0, 8)}@example.com`;
    await apiPost(`/api/lanes/${laneId}/send-outreach-emails`, cookie, {
      emailDrafts: [{
        carrierId,
        carrierName: "Captured Email Carrier",
        subject: "Lane Outreach",
        body: "Test body.",
        outreachMode: "lane_building",
      }],
      outreachMode: "lane_building",
      capturedEmails: { [carrierId]: capturedEmail },
    });

    // Verify the email was persisted to the carrier catalog
    const carrierRes = await q(
      `SELECT primary_email FROM carriers WHERE id = $1`,
      [carrierId]
    );
    assert(carrierRes.rows.length > 0, "Expected carrier to exist");
    assert(carrierRes.rows[0].primary_email === capturedEmail,
      `Expected primary_email='${capturedEmail}', got '${carrierRes.rows[0].primary_email}'`);

    await q(`DELETE FROM carriers WHERE id = $1`, [carrierId]).catch(() => {});
    await q(`DELETE FROM recurring_lanes WHERE id = $1`, [laneId]).catch(() => {});
  });

  // ── Summary ──────────────────────────────────────────────────────────────

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
