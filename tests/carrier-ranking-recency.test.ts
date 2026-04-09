/**
 * Carrier Ranking Recency & Staleness Fix — Unit Tests (Task #162)
 *
 * These tests exercise the scoring logic in carrierRankingService.ts by calling
 * the API endpoint against a live dev server and using isolated database records.
 *
 * Covers:
 *   (a) Carrier with no executed loads in 365+ days ranks below a carrier
 *       with a load in the last 30 days on the same lane.
 *   (b) Carrier with recent exact-lane history outranks a carrier with only
 *       region/equipment fit.
 *   (c) Carrier with recent customer history outranks one with no customer tie.
 *   (d) Having only email + region catalog + active status does not produce
 *       a top rank (score < 30).
 *   (e) Stale carrier explanation string includes staleness language.
 *   (f) Strong carrier explanation string includes exact-lane or recency language.
 *
 * Run with: npx tsx tests/carrier-ranking-recency.test.ts
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

async function createFreshOrg(): Promise<string> {
  const id = uid();
  const slug = `recency-test-${id.slice(0, 8)}`;
  const now = new Date().toISOString();
  await q(
    `INSERT INTO organizations (id, name, slug, created_at) VALUES ($1, $2, $3, $4)`,
    [id, `Recency Test Org ${id.slice(0, 6)}`, slug, now]
  );
  track("organizations", id);
  return id;
}

async function createUser(orgId: string, role: string): Promise<{ id: string; username: string; password: string }> {
  const id = uid();
  const password = `Pass${id.slice(0, 8)}!`;
  const hash = await bcrypt.hash(password, 10);
  const username = `recency.test.${id.slice(0, 8)}@example.com`;
  const now = new Date().toISOString();
  await q(
    `INSERT INTO users (id, organization_id, username, password, name, role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, orgId, username, hash, `RecencyTest ${id.slice(0, 6)}`, role, now]
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
  origin: string,
  destination: string,
  equipmentType?: string,
  companyName?: string,
  originState?: string,
  destState?: string,
): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO recurring_lanes
       (id, org_id, origin, destination, equipment_type, company_name, origin_state, destination_state,
        is_eligible, has_preferred_carrier_program, eligibility_confidence, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, false, 'medium', $9, $9)`,
    [id, orgId, origin, destination, equipmentType ?? null, companyName ?? null,
      originState ?? null, destState ?? null, now]
  );
  track("recurring_lanes", id);
  return id;
}

async function createCarrier(
  orgId: string,
  name: string,
  opts?: {
    primaryEmail?: string | null;
    regions?: string[];
    equipmentTypes?: string[];
  }
): Promise<string> {
  const id = uid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO carriers (id, org_id, name, primary_email, regions, equipment_types, tags, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [
      id, orgId, name,
      opts?.primaryEmail ?? null,
      opts?.regions ?? [],
      opts?.equipmentTypes ?? [],
      [],
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
      id, `recency-test-${id.slice(0, 8)}.csv`, now, uploadedBy, rows.length,
      JSON.stringify(rows), JSON.stringify([]), JSON.stringify([]),
      JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]),
    ]
  );
  track("financial_uploads", id);
  return id;
}

async function cleanup(): Promise<void> {
  const order = [
    "lane_carrier_interest",
    "financial_uploads",
    "lane_coverage_profile_carriers",
    "lane_coverage_profiles",
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

/** Return a YYYY-MM string for N months ago (approximate days). */
function monthsAgoKey(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\nCarrier Ranking Recency & Staleness — Task #162 tests\n");

  const orgId = await createFreshOrg();
  await enableFeatureFlag(orgId);

  const admin = await createUser(orgId, "admin");
  const cookie = await loginAs(admin.username, admin.password);

  // ── (a) Stale carrier ranks below recent carrier ──────────────────────────────
  await runTest("(a) Carrier with 365+ day stale load ranks below carrier with load in last 30 days", async () => {
    const laneId = await createLane(orgId, "dallas", "houston");

    // Recent carrier: 3 loads within last 30 days
    const recentCarrierId = await createCarrier(orgId, "RecentLaneCarrier162a", {
      primaryEmail: "recent@carrier162a.com",
      regions: ["TX"],
    });
    const recentMonth = monthsAgoKey(0); // current month → last day ≤ 30 days ago
    const recentRows = Array.from({ length: 3 }, () => ({
      shipperCity: "dallas",
      consigneeCity: "houston",
      carrier: "recentlanecarrier162a",
      month: recentMonth,
    }));
    await createFinancialUpload(admin.id, recentRows);

    // Stale carrier: 3 loads from 14 months ago
    const staleCarrierId = await createCarrier(orgId, "StaleLaneCarrier162a", {
      primaryEmail: "stale@carrier162a.com",
      regions: ["TX"],
    });
    const staleMonth = monthsAgoKey(14);
    const staleRows = Array.from({ length: 3 }, () => ({
      shipperCity: "dallas",
      consigneeCity: "houston",
      carrier: "stalelanecarrier162a",
      month: staleMonth,
    }));
    await createFinancialUpload(admin.id, staleRows);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&sort=recommended`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(json)}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number }> };
    assert(Array.isArray(data.carriers), "Expected carriers array");

    const recent = data.carriers.find(c => c.carrierName === "RecentLaneCarrier162a");
    const stale = data.carriers.find(c => c.carrierName === "StaleLaneCarrier162a");

    assert(!!recent, "RecentLaneCarrier162a should appear in suggestions");
    assert(!!stale, "StaleLaneCarrier162a should appear in suggestions");
    assert(
      recent!.fitScore > stale!.fitScore,
      `Recent carrier (${recent!.fitScore}) should outrank stale carrier (${stale!.fitScore})`
    );
  });

  // ── (b) Recent exact-lane history outranks region/equipment-fit-only ──────────
  await runTest("(b) Carrier with recent exact-lane history outranks carrier with only region/equipment fit", async () => {
    const laneId = await createLane(orgId, "memphis", "chicago", "dry van", undefined, "TN", "IL");

    // History carrier: 4 exact-lane loads within last 60 days
    const histCarrierId = await createCarrier(orgId, "HistoryCarrier162b", {
      primaryEmail: "hist@carrier162b.com",
      regions: ["TN", "IL"],
      equipmentTypes: ["dry van"],
    });
    const recentMonth = monthsAgoKey(1); // ~30-60 days ago
    const histRows = Array.from({ length: 4 }, () => ({
      shipperCity: "memphis",
      consigneeCity: "chicago",
      carrier: "historycarrier162b",
      equipmentType: "dry van",
      month: recentMonth,
    }));
    await createFinancialUpload(admin.id, histRows);

    // Pure prospect: only region + equipment fit, no history
    const prospectId = await createCarrier(orgId, "RegionProspect162b", {
      primaryEmail: "prospect@carrier162b.com",
      regions: ["TN", "IL"],
      equipmentTypes: ["dry van"],
    });

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&sort=recommended`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number; historyMatch: string }> };

    const hist = data.carriers.find(c => c.carrierName === "HistoryCarrier162b");
    const prospect = data.carriers.find(c => c.carrierName === "RegionProspect162b");

    assert(!!hist, "HistoryCarrier162b should appear");
    assert(!!prospect, "RegionProspect162b should appear");
    assert(hist!.historyMatch === "exact", `HistoryCarrier162b historyMatch should be 'exact', got '${hist!.historyMatch}'`);
    assert(
      hist!.fitScore > prospect!.fitScore,
      `History carrier (${hist!.fitScore}) should outrank region-only prospect (${prospect!.fitScore})`
    );
  });

  // ── (c) Customer history carrier outranks one with no customer tie ────────────
  await runTest("(c) Carrier with recent customer history outranks one with no customer tie", async () => {
    const laneId = await createLane(orgId, "atlanta", "nashville", undefined, "Acme Shippers");

    // Customer history carrier: hauled for Acme Shippers before
    const custCarrierId = await createCarrier(orgId, "CustomerCarrier162c", {
      primaryEmail: "cust@carrier162c.com",
      regions: ["GA", "TN"],
    });
    const custRows = Array.from({ length: 3 }, () => ({
      shipperCity: "atlanta",
      consigneeCity: "nashville",
      carrier: "customercarrier162c",
      customerName: "acme shippers",
      month: monthsAgoKey(1),
    }));
    await createFinancialUpload(admin.id, custRows);

    // No-customer-tie carrier: same region, same equipment, but no customer history
    const noTieCarrierId = await createCarrier(orgId, "NoTieCarrier162c", {
      primaryEmail: "notie@carrier162c.com",
      regions: ["GA", "TN"],
    });
    // Also give noTie carrier some lane history but without customerName
    const noTieRows = Array.from({ length: 3 }, () => ({
      shipperCity: "atlanta",
      consigneeCity: "nashville",
      carrier: "notiecarrier162c",
      month: monthsAgoKey(1),
    }));
    await createFinancialUpload(admin.id, noTieRows);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&sort=recommended`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number; customerHistoryLoads: number }> };

    const custCarrier = data.carriers.find(c => c.carrierName === "CustomerCarrier162c");
    const noTieCarrier = data.carriers.find(c => c.carrierName === "NoTieCarrier162c");

    assert(!!custCarrier, "CustomerCarrier162c should appear");
    assert(!!noTieCarrier, "NoTieCarrier162c should appear");
    assert(
      custCarrier!.customerHistoryLoads > 0,
      `CustomerCarrier162c should have customerHistoryLoads > 0, got ${custCarrier!.customerHistoryLoads}`
    );
    assert(
      custCarrier!.fitScore > noTieCarrier!.fitScore,
      `Customer-tie carrier (${custCarrier!.fitScore}) should outrank no-tie carrier (${noTieCarrier!.fitScore})`
    );
  });

  // ── (d) Email + region + active alone cannot force top rank ──────────────────
  await runTest("(d) Email + region catalog + active status alone does not produce a top rank (score < 30)", async () => {
    const laneId = await createLane(orgId, "phoenix", "tucson", undefined, undefined, "AZ", "AZ");

    // Carrier with email + region — no load history
    const weakSignalId = await createCarrier(orgId, "WeakSignalCarrier162d", {
      primaryEmail: "weak@carrier162d.com",
      regions: ["AZ"],
    });

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&sort=recommended`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number }> };

    const weakCarrier = data.carriers.find(c => c.carrierName === "WeakSignalCarrier162d");
    assert(!!weakCarrier, "WeakSignalCarrier162d should appear");
    assert(
      weakCarrier!.fitScore < 30,
      `Carrier with only email + region should have fitScore < 30 (got ${weakCarrier!.fitScore})`
    );
  });

  // ── (e) Stale carrier explanation string includes staleness language ──────────
  await runTest("(e) Stale carrier explanation includes staleness language", async () => {
    const laneId = await createLane(orgId, "portland", "seattle");

    const staleId = await createCarrier(orgId, "StaleExplainCarrier162e", {
      primaryEmail: "stale@explain162e.com",
      regions: ["OR", "WA"],
    });
    // 15 months ago → stale
    const staleMonth = monthsAgoKey(15);
    const staleRows = Array.from({ length: 2 }, () => ({
      shipperCity: "portland",
      consigneeCity: "seattle",
      carrier: "staleexplaincarrier162e",
      month: staleMonth,
    }));
    await createFinancialUpload(admin.id, staleRows);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitReason: string; suppressionReasons: string[] }> };

    const staleCarrier = data.carriers.find(c => c.carrierName === "StaleExplainCarrier162e");
    assert(!!staleCarrier, "StaleExplainCarrier162e should appear");

    // Either fitReason or suppressionReasons should contain staleness language
    const combinedText = [staleCarrier!.fitReason, ...staleCarrier!.suppressionReasons].join(" ").toLowerCase();
    const hasStaleness =
      combinedText.includes("fallback") ||
      combinedText.includes("no executed loads") ||
      combinedText.includes("days ago");
    assert(
      hasStaleness,
      `Stale carrier should have staleness language in fitReason or suppressionReasons. Got: fitReason="${staleCarrier!.fitReason}", suppressionReasons=${JSON.stringify(staleCarrier!.suppressionReasons)}`
    );
  });

  // ── (f) Strong carrier explanation includes exact-lane or recency language ───
  await runTest("(f) Strong carrier explanation includes exact-lane or recency language", async () => {
    const laneId = await createLane(orgId, "denver", "saltlake");

    const strongId = await createCarrier(orgId, "StrongCarrier162f", {
      primaryEmail: "strong@carrier162f.com",
      regions: ["CO", "UT"],
    });
    const recentMonth = monthsAgoKey(1); // ~1 month ago
    const strongRows = Array.from({ length: 8 }, () => ({
      shipperCity: "denver",
      consigneeCity: "saltlake",
      carrier: "strongcarrier162f",
      month: recentMonth,
    }));
    await createFinancialUpload(admin.id, strongRows);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitReason: string }> };

    const strongCarrier = data.carriers.find(c => c.carrierName === "StrongCarrier162f");
    assert(!!strongCarrier, "StrongCarrier162f should appear");

    const reason = strongCarrier!.fitReason.toLowerCase();
    const hasExactLaneLanguage =
      reason.includes("exact lane") ||
      reason.includes("ran this exact") ||
      reason.includes("last 90 days") ||
      reason.includes("days ago") ||
      reason.includes("months ago");
    assert(
      hasExactLaneLanguage,
      `Strong carrier should have exact-lane or recency language in fitReason. Got: "${strongCarrier!.fitReason}"`
    );
  });

  // ── (g) No-history catalog carrier gets stale treatment (-25 penalty) ────────
  await runTest("(g) No-history catalog carrier (no loads ever) scores below region-only carrier with recent history", async () => {
    const laneId = await createLane(orgId, "losangeles", "sandiego", undefined, undefined, "CA", "CA");

    // Carrier with recent history (2 months ago)
    const recentHistId = await createCarrier(orgId, "RecentHistCarrier162g", {
      primaryEmail: "recenth@carrier162g.com",
      regions: ["CA"],
    });
    const histRows = Array.from({ length: 3 }, () => ({
      shipperCity: "losangeles",
      consigneeCity: "sandiego",
      carrier: "recenthistcarrier162g",
      month: monthsAgoKey(2),
    }));
    await createFinancialUpload(admin.id, histRows);

    // No-history carrier: in region, has email, active — but zero executed loads
    const noHistId = await createCarrier(orgId, "NoHistCarrier162g", {
      primaryEmail: "nohist@carrier162g.com",
      regions: ["CA"],
    });

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&sort=recommended`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number; suppressionReasons: string[] }> };

    const recentHist = data.carriers.find(c => c.carrierName === "RecentHistCarrier162g");
    const noHist = data.carriers.find(c => c.carrierName === "NoHistCarrier162g");

    assert(!!recentHist, "RecentHistCarrier162g should appear");
    assert(!!noHist, "NoHistCarrier162g should appear (visible as fallback)");

    assert(
      recentHist!.fitScore > noHist!.fitScore,
      `Recent-history carrier (${recentHist!.fitScore}) should outrank no-history carrier (${noHist!.fitScore})`
    );

    // No-history carrier should have staleness language in suppressionReasons
    const suppText = noHist!.suppressionReasons.join(" ").toLowerCase();
    const hasStalenessText =
      suppText.includes("no executed loads") ||
      suppText.includes("fallback");
    assert(
      hasStalenessText,
      `No-history carrier should have staleness suppression. Got: ${JSON.stringify(noHist!.suppressionReasons)}`
    );
  });

  // ── (h) Active + contactable + region-fit, no loads in 365+ days ranks below recent proven ──
  await runTest("(h) Active carrier with email + region but no loads in 365+ days ranks below recent proven carrier", async () => {
    const laneId = await createLane(orgId, "miami", "orlando");

    // Proven recent carrier
    const provenId = await createCarrier(orgId, "ProvenCarrier162h", {
      primaryEmail: "proven@carrier162h.com",
      regions: ["FL"],
    });
    const provenRows = Array.from({ length: 5 }, () => ({
      shipperCity: "miami",
      consigneeCity: "orlando",
      carrier: "provencarrier162h",
      month: monthsAgoKey(1),
    }));
    await createFinancialUpload(admin.id, provenRows);

    // Stale active carrier: email + region + some old history (16 months ago)
    const staleActiveId = await createCarrier(orgId, "StaleActiveCarrier162h", {
      primaryEmail: "staleactive@carrier162h.com",
      regions: ["FL"],
    });
    const staleRows = Array.from({ length: 5 }, () => ({
      shipperCity: "miami",
      consigneeCity: "orlando",
      carrier: "staleactivecarrier162h",
      month: monthsAgoKey(16), // 16 months = 488+ days stale
    }));
    await createFinancialUpload(admin.id, staleRows);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&sort=recommended`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number }> };

    const proven = data.carriers.find(c => c.carrierName === "ProvenCarrier162h");
    const staleActive = data.carriers.find(c => c.carrierName === "StaleActiveCarrier162h");

    assert(!!proven, "ProvenCarrier162h should appear");
    assert(!!staleActive, "StaleActiveCarrier162h should appear as fallback");
    assert(
      proven!.fitScore > staleActive!.fitScore,
      `Proven recent carrier (${proven!.fitScore}) should outrank stale active carrier (${staleActive!.fitScore})`
    );
  });

  // ── (i) Top-ranked carrier on a lane should be the most credible recent one ──
  await runTest("(i) Top-ranked carrier is the recent proven one, not the stale or weak-signal one", async () => {
    const laneId = await createLane(orgId, "boston", "newyork", undefined, undefined, "MA", "NY");

    // Strong recent carrier
    const strongId = await createCarrier(orgId, "StrongRecent162i", {
      primaryEmail: "strong@carrier162i.com",
      regions: ["MA", "NY"],
    });
    const strongRows = Array.from({ length: 8 }, () => ({
      shipperCity: "boston",
      consigneeCity: "newyork",
      carrier: "strongrecent162i",
      month: monthsAgoKey(0),
    }));
    await createFinancialUpload(admin.id, strongRows);

    // Stale carrier: old history
    const staleId = await createCarrier(orgId, "StaleBottom162i", {
      primaryEmail: "stale@carrier162i.com",
      regions: ["MA", "NY"],
    });
    const staleRows2 = Array.from({ length: 8 }, () => ({
      shipperCity: "boston",
      consigneeCity: "newyork",
      carrier: "stalebottom162i",
      month: monthsAgoKey(18),
    }));
    await createFinancialUpload(admin.id, staleRows2);

    // Weak-signal-only carrier: email + region, no history
    const weakId = await createCarrier(orgId, "WeakSignal162i", {
      primaryEmail: "weak@carrier162i.com",
      regions: ["MA", "NY"],
    });

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&sort=recommended`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number }> };

    const strong = data.carriers.find(c => c.carrierName === "StrongRecent162i");
    const staleC = data.carriers.find(c => c.carrierName === "StaleBottom162i");
    const weak = data.carriers.find(c => c.carrierName === "WeakSignal162i");

    assert(!!strong, "StrongRecent162i should appear");
    assert(!!staleC, "StaleBottom162i should appear as fallback");
    assert(!!weak, "WeakSignal162i should appear");

    // Verify ordering: strong > stale > weak (or at minimum strong is first)
    assert(strong!.fitScore > staleC!.fitScore, `Strong recent (${strong!.fitScore}) should beat stale (${staleC!.fitScore})`);
    assert(strong!.fitScore > weak!.fitScore, `Strong recent (${strong!.fitScore}) should beat weak-signal (${weak!.fitScore})`);
    assert(staleC!.fitScore >= weak!.fitScore, `Stale with proven history (${staleC!.fitScore}) should be >= weak-signal-only (${weak!.fitScore})`);

    // Strong carrier must be first (or tied first)
    const topScore = data.carriers[0].fitScore;
    assert(
      strong!.fitScore >= topScore,
      `StrongRecent162i (${strong!.fitScore}) should be the top-ranked carrier, but top score is ${topScore} (${data.carriers[0].carrierName})`
    );
  });

  // ── (j) Stale exact-lane incumbent is demoted below fresh customer-history carrier ──
  await runTest("(j) Stale exact-lane carrier (365+ days) ranks below recent customer-history carrier", async () => {
    // Lane: Omaha → Lincoln, NE, customer "Midwest Freight Co"
    const laneId = await createLane(orgId, "omaha", "lincoln", undefined, "Midwest Freight Co", "NE", "NE");

    // Carrier A: stale exact-lane history (3 loads, 15 months ago)
    // Expected score: exactFloor(55) + equip(+6) + recency(-25) = ~36
    const staleExactId = await createCarrier(orgId, "StaleExact162j", {
      primaryEmail: "staleexact@162j.com",
      regions: ["CO"],  // no NE match — no region boost
    });
    const staleMonth = monthsAgoKey(15);
    const staleExactRows = Array.from({ length: 3 }, () => ({
      shipperCity: "omaha",
      consigneeCity: "lincoln",
      carrier: "staleexact162j",
      month: staleMonth,
    }));
    await createFinancialUpload(admin.id, staleExactRows);

    // Carrier B: no exact-lane loads, but state-pair loads last month + strong customer history
    // Expected score: statePair(+12) + equip(+6) + region(+3) + recency(+10) + customer(+20) = ~51
    const recentCustId = await createCarrier(orgId, "RecentCustomer162j", {
      primaryEmail: "recentcust@162j.com",
      regions: ["NE"],  // matches lane state
    });
    const recentMonth = monthsAgoKey(1); // ~30-60 days ago
    // State-pair loads (different NE→NE cities, not omaha→lincoln).
    // Must include shipperState/consigneeState so the state-pair matcher fires.
    const statePairRows = Array.from({ length: 3 }, () => ({
      shipperCity: "columbus",
      shipperState: "NE",
      consigneeCity: "hastings",
      consigneeState: "NE",
      carrier: "recentcustomer162j",
      month: recentMonth,
    }));
    await createFinancialUpload(admin.id, statePairRows);
    // Customer history rows — Carrier B has hauled for Midwest Freight Co
    const custRows = Array.from({ length: 5 }, () => ({
      shipperCity: "columbus",
      shipperState: "NE",
      consigneeCity: "hastings",
      consigneeState: "NE",
      carrier: "recentcustomer162j",
      customerName: "midwest freight co",
      month: recentMonth,
    }));
    await createFinancialUpload(admin.id, custRows);

    const { status, json } = await apiGet(
      `/api/lanes/${laneId}/carrier-suggestions?pageSize=0&sort=recommended`,
      cookie
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const data = json as { carriers: Array<{ carrierName: string; fitScore: number; historyMatch: string }> };

    const staleExact = data.carriers.find(c => c.carrierName === "StaleExact162j");
    const recentCust = data.carriers.find(c => c.carrierName === "RecentCustomer162j");

    assert(!!staleExact, "StaleExact162j should appear (as fallback)");
    assert(!!recentCust, "RecentCustomer162j should appear");
    assert(staleExact!.historyMatch === "exact", `StaleExact162j historyMatch should be 'exact', got '${staleExact!.historyMatch}'`);
    assert(
      recentCust!.fitScore > staleExact!.fitScore,
      `Recent customer-history carrier (${recentCust!.fitScore}) should outrank stale exact-lane carrier (${staleExact!.fitScore})`
    );

    // Verify stale carrier is NOT the top-ranked result (score-first sort should demote it)
    const topCarrierName = data.carriers[0]?.carrierName;
    assert(
      topCarrierName !== "StaleExact162j",
      `Top result should not be the stale carrier — got ${topCarrierName} at score ${data.carriers[0]?.fitScore}`
    );
  });

  // ── Summary ──────────────────────────────────────────────────────────────────

  console.log(`\nResults: ${results.filter(r => r.passed).length}/${results.length} passed\n`);

  const failed = results.filter(r => !r.passed);
  if (failed.length > 0) {
    console.log("Failed tests:");
    for (const f of failed) {
      console.log(`  ✗ ${f.name}: ${f.error}`);
    }
  }

  await cleanup();
  await pool.end();

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Unexpected error:", err);
  pool.end().finally(() => process.exit(1));
});
