/**
 * End-to-end test for the won-quote → Lane Work Queue (LWQ) handoff.
 *
 * Covers Task #477 acceptance criteria:
 *   1. Marking a quote "won" with the default flow auto-creates exactly one
 *      recurring_lanes row whose source_quote_id matches the quote.
 *   2. Re-marking the same quote "won" (transitioning pending → won again)
 *      is idempotent — no duplicate lane is created.
 *   3. Marking a fresh quote "won" with skipLwqHandoff=true (the UI sends
 *      this when the rep unchecks "Create LWQ lane" in the win dialog) does
 *      NOT create a recurring_lanes row.
 *
 * Run with: npx tsx tests/won-quote-lwq-handoff.test.ts
 *
 * Requires the dev server to be running on port 5000.
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

interface TestResult { name: string; passed: boolean; error?: string }
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

// ── Auth + API helpers ────────────────────────────────────────────────────────

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
  if (!sessionCookie) throw new Error(`No session cookie for ${username}`);
  return sessionCookie;
}

async function apiPost(path: string, cookie: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await httpRequest({
    method: "POST", path,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: any;
  try { json = JSON.parse(res.body); } catch { json = res.body; }
  return { status: res.status, json };
}

async function apiPatch(path: string, cookie: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await httpRequest({
    method: "PATCH", path,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: any;
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
  const username = `lwq.handoff.test.${id.slice(0, 8)}@example.com`;
  const now = new Date().toISOString();
  await q(
    `INSERT INTO users (id, organization_id, username, password, name, role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, orgId, username, hash, `WonQuoteTest ${id.slice(0, 6)}`, role, now]
  );
  track("users", id);
  return { id, username, password };
}

async function createCustomer(orgId: string): Promise<{ id: string; name: string }> {
  const id = uid();
  const name = `LWQTest Customer ${id.slice(0, 8)}`;
  await q(
    `INSERT INTO quote_customers (id, organization_id, name, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [id, orgId, name]
  );
  track("quote_customers", id);
  return { id, name };
}

async function createPendingQuote(cookie: string, customerId: string): Promise<string> {
  const { status, json } = await apiPost("/api/customer-quotes/quote", cookie, {
    customerId,
    originCity: "Chicago", originState: "IL",
    destCity: "Dallas", destState: "TX",
    equipment: "Dry Van",
    quotedAmount: 2500,
    outcomeStatus: "pending",
    source: "manual",
  });
  if (status !== 201) throw new Error(`Create quote failed: ${status} ${JSON.stringify(json)}`);
  const quoteId: string | undefined = json?.opp?.id ?? json?.id ?? json?.quote?.id;
  if (!quoteId) throw new Error(`No quote id in response: ${JSON.stringify(json)}`);
  track("quote_opportunities", quoteId);
  return quoteId;
}

async function lanesForQuote(quoteId: string): Promise<string[]> {
  const res = await q(
    `SELECT id FROM recurring_lanes WHERE source_quote_id = $1`,
    [quoteId]
  );
  return res.rows.map(r => r.id as string);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  // Recurring lanes auto-created via the handoff aren't tracked individually;
  // delete every lane that points to one of our tracked quote_opportunities.
  const quoteIds = cleanupIds.filter(c => c.table === "quote_opportunities").map(c => c.id);
  for (const qid of quoteIds) {
    await q(`DELETE FROM recurring_lanes WHERE source_quote_id = $1`, [qid]).catch(() => {});
    await q(`DELETE FROM quote_events WHERE quote_id = $1`, [qid]).catch(() => {});
  }
  const order = ["quote_opportunities", "quote_customers", "users"];
  for (const table of order) {
    const ids = cleanupIds.filter(c => c.table === table).map(c => c.id);
    for (const id of ids) {
      await q(`DELETE FROM ${table} WHERE id = $1`, [id]).catch(() => {});
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\nWon-Quote → LWQ Handoff e2e tests (Task #477)\n");

  const orgId = await getDefaultOrgId();
  const user = await createUser(orgId, "director");
  const cookie = await loginAs(user.username, user.password);
  const customer = await createCustomer(orgId);

  // ── 1. Won transition with default (LWQ checkbox checked) creates a lane.
  let quoteAId: string;
  await runTest("Marking a quote 'won' creates exactly one recurring_lanes row with source_quote_id set", async () => {
    quoteAId = await createPendingQuote(cookie, customer.id);
    const { status } = await apiPatch(`/api/customer-quotes/quote/${quoteAId}`, cookie, {
      outcomeStatus: "won",
      // skipLwqHandoff omitted → server should run the handoff
    });
    assert(status === 200, `PATCH won failed: ${status}`);

    const lanes = await lanesForQuote(quoteAId);
    assert(lanes.length === 1, `Expected 1 lane for quote ${quoteAId}, got ${lanes.length}`);

    const row = await q(
      `SELECT source_quote_id, origin, destination, equipment_type, is_manual
         FROM recurring_lanes WHERE id = $1`,
      [lanes[0]]
    );
    const lane = row.rows[0];
    assert(lane.source_quote_id === quoteAId, `source_quote_id mismatch: ${lane.source_quote_id}`);
    assert(typeof lane.origin === "string" && lane.origin.length > 0, "lane.origin should be set");
    assert(typeof lane.destination === "string" && lane.destination.length > 0, "lane.destination should be set");
    assert(lane.is_manual === true, "lane.is_manual should be true so the eligibility engine doesn't retract it");
  });

  // ── 2. Idempotency: re-running the won transition does not create a 2nd lane.
  await runTest("Marking the same quote won again is idempotent — no second lane is created", async () => {
    // Flip back to pending so the next PATCH actually fires a status change
    // (and re-invokes createLwqLaneFromWonQuote on the server).
    const r1 = await apiPatch(`/api/customer-quotes/quote/${quoteAId}`, cookie, {
      outcomeStatus: "pending",
    });
    assert(r1.status === 200, `Reset to pending failed: ${r1.status}`);

    const r2 = await apiPatch(`/api/customer-quotes/quote/${quoteAId}`, cookie, {
      outcomeStatus: "won",
    });
    assert(r2.status === 200, `Second PATCH won failed: ${r2.status}`);

    const lanes = await lanesForQuote(quoteAId);
    assert(
      lanes.length === 1,
      `Expected still exactly 1 lane after second won transition, got ${lanes.length}`
    );
  });

  // ── 3. Unchecked checkbox path: skipLwqHandoff=true creates no lane.
  await runTest("Marking a quote won with skipLwqHandoff=true does NOT create a recurring_lanes row", async () => {
    const quoteBId = await createPendingQuote(cookie, customer.id);
    const { status } = await apiPatch(`/api/customer-quotes/quote/${quoteBId}`, cookie, {
      outcomeStatus: "won",
      skipLwqHandoff: true,
    });
    assert(status === 200, `PATCH won (skip) failed: ${status}`);

    const lanes = await lanesForQuote(quoteBId);
    assert(
      lanes.length === 0,
      `Expected 0 lanes when skipLwqHandoff=true, got ${lanes.length}`
    );
  });

  // ── Summary ─────────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed (${results.length} total)\n`);

  await cleanup();
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async err => {
  console.error("\nFatal:", err);
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
