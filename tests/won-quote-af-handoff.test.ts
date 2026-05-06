/**
 * End-to-end test for the won-quote → Available Freight (AF) same-day cover
 * handoff (Task #654).
 *
 * Covers acceptance criteria:
 *   (a) Winning a quote with pickup ≤72h creates exactly one matching
 *       freight_opportunities row in `ready_to_send` status, on the same
 *       org, tied to the same customer, with the quote's buy/sell rate
 *       carried in `source_ref = { type: "won_quote", quoteId, buy, sell }`.
 *   (b) Winning a quote with pickup > 72h does NOT create an AF row.
 *   (c) Re-marking the same quote won is idempotent — no duplicate AF row.
 *   (d) The existing LWQ recurring-lane handoff still fires alongside the
 *       AF handoff when both apply.
 *   (e) Toggling the org-level setting `auto_won_quote_af_handoff` to false
 *       short-circuits the handoff.
 *
 * Run with: npx tsx tests/won-quote-af-handoff.test.ts
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
function uid(): string { return crypto.randomUUID(); }

// ── Test harness ──────────────────────────────────────────────────────────────

interface TestResult { name: string; passed: boolean; error?: string }
const results: TestResult[] = [];
const cleanupIds: { table: string; id: string }[] = [];
function track(table: string, id: string): void { cleanupIds.push({ table, id }); }

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
async function apiPut(path: string, cookie: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await httpRequest({
    method: "PUT", path,
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
  const username = `af.handoff.test.${id.slice(0, 8)}@example.com`;
  const now = new Date().toISOString();
  await q(
    `INSERT INTO users (id, organization_id, username, password, name, role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, orgId, username, hash, `WonQuoteAfTest ${id.slice(0, 6)}`, role, now]
  );
  track("users", id);
  return { id, username, password };
}

/**
 * Creates a quote_customer AND a matching companies row with the same name.
 * The AF handoff requires a CRM company to attach companyId to (NOT NULL),
 * so the LWQ-only test's customer-only fixture would skip the handoff path.
 */
async function createCustomerAndCompany(orgId: string): Promise<{ customerId: string; companyId: string; name: string }> {
  const customerId = uid();
  const companyId = uid();
  const name = `AfHandoffTest Customer ${customerId.slice(0, 8)}`;
  await q(
    `INSERT INTO quote_customers (id, organization_id, name, created_at) VALUES ($1, $2, $3, NOW())`,
    [customerId, orgId, name]
  );
  track("quote_customers", customerId);
  await q(
    `INSERT INTO companies (id, organization_id, name) VALUES ($1, $2, $3)`,
    [companyId, orgId, name]
  );
  track("companies", companyId);
  return { customerId, companyId, name };
}

interface CreatePendingQuoteOptions {
  pickupHoursFromNow: number;
  quotedAmount?: number;
  carrierPaid?: number;
}

async function createPendingQuote(
  cookie: string,
  customerId: string,
  opts: CreatePendingQuoteOptions,
): Promise<string> {
  // requestDate is the pickup proxy used by the same-day handoff window.
  const requestDate = new Date(Date.now() + opts.pickupHoursFromNow * 3600 * 1000).toISOString();
  const { status, json } = await apiPost("/api/customer-quotes/quote", cookie, {
    customerId,
    originCity: "Chicago", originState: "IL",
    destCity: "Dallas", destState: "TX",
    equipment: "Dry Van",
    quotedAmount: opts.quotedAmount ?? 2500,
    outcomeStatus: "pending",
    source: "manual",
    requestDate,
    carrierPaid: opts.carrierPaid ?? null,
  });
  if (status !== 201) throw new Error(`Create quote failed: ${status} ${JSON.stringify(json)}`);
  const quoteId: string | undefined = json?.opp?.id ?? json?.id ?? json?.quote?.id;
  if (!quoteId) throw new Error(`No quote id in response: ${JSON.stringify(json)}`);
  track("quote_opportunities", quoteId);
  return quoteId;
}

async function afOppsForQuote(orgId: string, quoteId: string): Promise<Array<{ id: string; status: string; sourceRef: any; companyId: string }>> {
  const res = await q(
    `SELECT id, status, source_ref, company_id
       FROM freight_opportunities
      WHERE org_id = $1
        AND source_ref->>'type' = 'won_quote'
        AND source_ref->>'quoteId' = $2`,
    [orgId, quoteId]
  );
  return res.rows.map(r => ({ id: r.id as string, status: r.status as string, sourceRef: r.source_ref, companyId: r.company_id as string }));
}

async function lanesForQuote(quoteId: string): Promise<string[]> {
  const res = await q(`SELECT id FROM recurring_lanes WHERE source_quote_id = $1`, [quoteId]);
  return res.rows.map(r => r.id as string);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup(orgId: string): Promise<void> {
  // Wipe AF opportunities + recurring lanes attached to our quotes first.
  const quoteIds = cleanupIds.filter(c => c.table === "quote_opportunities").map(c => c.id);
  for (const qid of quoteIds) {
    await q(
      `DELETE FROM freight_opportunities
        WHERE org_id = $1
          AND source_ref->>'type' = 'won_quote'
          AND source_ref->>'quoteId' = $2`,
      [orgId, qid]
    ).catch(() => {});
    await q(`DELETE FROM recurring_lanes WHERE source_quote_id = $1`, [qid]).catch(() => {});
    await q(`DELETE FROM quote_events WHERE quote_id = $1`, [qid]).catch(() => {});
  }
  const order = ["quote_opportunities", "quote_customers", "companies", "users"];
  for (const table of order) {
    const ids = cleanupIds.filter(c => c.table === table).map(c => c.id);
    for (const id of ids) {
      await q(`DELETE FROM ${table} WHERE id = $1`, [id]).catch(() => {});
    }
  }
  // Restore the default-on setting state for this org so we don't leak the
  // disabled flag into other tests sharing the same org.
  await q(
    `DELETE FROM app_settings WHERE key = $1`,
    [`auto_won_quote_af_handoff:${orgId}`]
  ).catch(() => {});
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\nWon-Quote → Available Freight handoff e2e tests (Task #654)\n");

  const orgId = await getDefaultOrgId();
  const user = await createUser(orgId, "director");
  const cookie = await loginAs(user.username, user.password);

  // (a) Same-day quote → AF row appears with the right shape.
  await runTest("Pickup in 24h: winning a quote creates a freight_opportunities row in ready_to_send with sourceRef", async () => {
    const fix = await createCustomerAndCompany(orgId);
    const quoteId = await createPendingQuote(cookie, fix.customerId, {
      pickupHoursFromNow: 24,
      quotedAmount: 2750,
      carrierPaid: 2200,
    });
    const { status } = await apiPatch(`/api/customer-quotes/quote/${quoteId}`, cookie, {
      outcomeStatus: "won",
    });
    assert(status === 200, `PATCH won failed: ${status}`);

    const opps = await afOppsForQuote(orgId, quoteId);
    assert(opps.length === 1, `Expected 1 AF opp, got ${opps.length}`);
    const opp = opps[0];
    assert(opp.status === "ready_to_send", `Expected status ready_to_send, got ${opp.status}`);
    assert(opp.companyId === fix.companyId, `companyId mismatch: ${opp.companyId} vs ${fix.companyId}`);
    assert(opp.sourceRef?.type === "won_quote", `sourceRef.type should be won_quote, got ${opp.sourceRef?.type}`);
    assert(opp.sourceRef?.quoteId === quoteId, `sourceRef.quoteId mismatch`);
    // Sell rate (quotedAmount) is persisted as a decimal-string by the quote
    // schema, so the JSON value is the same string. Buy rate (carrierPaid)
    // matches the same shape.
    assert(String(opp.sourceRef?.sell) === "2750.00" || String(opp.sourceRef?.sell) === "2750",
      `sourceRef.sell should be 2750, got ${opp.sourceRef?.sell}`);
    assert(String(opp.sourceRef?.buy) === "2200.00" || String(opp.sourceRef?.buy) === "2200",
      `sourceRef.buy should be 2200, got ${opp.sourceRef?.buy}`);
  });

  // (b) Pickup 5 days out → no AF row.
  await runTest("Pickup in 5 days: winning a quote does NOT create a freight_opportunities row", async () => {
    const fix = await createCustomerAndCompany(orgId);
    const quoteId = await createPendingQuote(cookie, fix.customerId, { pickupHoursFromNow: 5 * 24 });
    const { status } = await apiPatch(`/api/customer-quotes/quote/${quoteId}`, cookie, {
      outcomeStatus: "won",
    });
    assert(status === 200, `PATCH won failed: ${status}`);
    const opps = await afOppsForQuote(orgId, quoteId);
    assert(opps.length === 0, `Expected 0 AF opps for >72h pickup, got ${opps.length}`);
  });

  // (c) Idempotency: re-winning the same quote does NOT duplicate the AF row.
  await runTest("Re-marking the same quote won is idempotent — no duplicate AF row", async () => {
    const fix = await createCustomerAndCompany(orgId);
    const quoteId = await createPendingQuote(cookie, fix.customerId, { pickupHoursFromNow: 24 });
    const r1 = await apiPatch(`/api/customer-quotes/quote/${quoteId}`, cookie, { outcomeStatus: "won" });
    assert(r1.status === 200, `First PATCH won failed: ${r1.status}`);
    let opps = await afOppsForQuote(orgId, quoteId);
    assert(opps.length === 1, `Expected 1 AF opp after first win, got ${opps.length}`);
    const firstId = opps[0].id;

    // Flip back to pending so the next PATCH actually fires a status change
    // and re-invokes the handoff branch in updateQuote.
    const r2 = await apiPatch(`/api/customer-quotes/quote/${quoteId}`, cookie, { outcomeStatus: "pending" });
    assert(r2.status === 200, `Reset to pending failed: ${r2.status}`);
    const r3 = await apiPatch(`/api/customer-quotes/quote/${quoteId}`, cookie, { outcomeStatus: "won" });
    assert(r3.status === 200, `Second PATCH won failed: ${r3.status}`);
    opps = await afOppsForQuote(orgId, quoteId);
    assert(opps.length === 1, `Expected 1 AF opp after re-win (idempotent), got ${opps.length}`);
    assert(opps[0].id === firstId, `AF opp id should be unchanged across re-win`);
  });

  // (d) The existing LWQ handoff still fires alongside the AF handoff.
  await runTest("Same-day win still creates the LWQ recurring lane in addition to the AF row", async () => {
    const fix = await createCustomerAndCompany(orgId);
    const quoteId = await createPendingQuote(cookie, fix.customerId, { pickupHoursFromNow: 24 });
    const { status } = await apiPatch(`/api/customer-quotes/quote/${quoteId}`, cookie, {
      outcomeStatus: "won",
    });
    assert(status === 200, `PATCH won failed: ${status}`);
    const lanes = await lanesForQuote(quoteId);
    assert(lanes.length === 1, `Expected 1 LWQ lane (existing path), got ${lanes.length}`);
    const opps = await afOppsForQuote(orgId, quoteId);
    assert(opps.length === 1, `Expected 1 AF opp (new path), got ${opps.length}`);
  });

  // (f) Re-saving an already-won quote (no status transition) updates the
  //     existing AF row in place rather than creating a duplicate. This is
  //     the "rep edits buy/sell after winning" path — the AF cockpit needs
  //     to see those edits without spawning a second opp.
  await runTest("Re-saving an already-won quote (no status change) updates the existing AF row in place", async () => {
    const fix = await createCustomerAndCompany(orgId);
    const quoteId = await createPendingQuote(cookie, fix.customerId, {
      pickupHoursFromNow: 24,
      quotedAmount: 2000,
      carrierPaid: 1500,
    });
    const r1 = await apiPatch(`/api/customer-quotes/quote/${quoteId}`, cookie, { outcomeStatus: "won" });
    assert(r1.status === 200, `Initial PATCH won failed: ${r1.status}`);
    const before = await afOppsForQuote(orgId, quoteId);
    assert(before.length === 1, `Expected 1 AF opp after initial win, got ${before.length}`);
    const oppId = before[0].id;
    assert(String(before[0].sourceRef?.sell) === "2000.00" || String(before[0].sourceRef?.sell) === "2000",
      `Initial sell should be 2000, got ${before[0].sourceRef?.sell}`);

    // Re-save WITHOUT changing outcomeStatus — only edit the buy rate.
    // Should update the AF row's sourceRef.buy in place, not duplicate.
    const r2 = await apiPatch(`/api/customer-quotes/quote/${quoteId}`, cookie, { carrierPaid: 1750 });
    assert(r2.status === 200, `Re-save without status change failed: ${r2.status}`);
    const after = await afOppsForQuote(orgId, quoteId);
    assert(after.length === 1, `Expected still 1 AF opp after re-save, got ${after.length}`);
    assert(after[0].id === oppId, `AF opp id should be unchanged across re-save (got ${after[0].id} vs ${oppId})`);
    assert(String(after[0].sourceRef?.buy) === "1750.00" || String(after[0].sourceRef?.buy) === "1750",
      `Updated buy should be 1750, got ${after[0].sourceRef?.buy}`);
  });

  // (g) Won quote whose customer name has no matching CRM company → handoff
  //     auto-creates a minimal company so the AF row still lands. Without
  //     this, a valid won quote for a brand-new customer would silently
  //     drop on the floor.
  await runTest("Won quote with no matching CRM company auto-creates one and still produces an AF row", async () => {
    const customerId = uid();
    const customerName = `AfHandoffTest NoCompany ${customerId.slice(0, 8)}`;
    await q(
      `INSERT INTO quote_customers (id, organization_id, name, created_at) VALUES ($1, $2, $3, NOW())`,
      [customerId, orgId, customerName]
    );
    track("quote_customers", customerId);

    const quoteId = await createPendingQuote(cookie, customerId, { pickupHoursFromNow: 24 });
    const { status } = await apiPatch(`/api/customer-quotes/quote/${quoteId}`, cookie, {
      outcomeStatus: "won",
    });
    assert(status === 200, `PATCH won failed: ${status}`);

    const opps = await afOppsForQuote(orgId, quoteId);
    assert(opps.length === 1, `Expected 1 AF opp after auto-create, got ${opps.length}`);
    // Verify a CRM company was created for this name in this org and the
    // AF row points at it.
    const companyRes = await q(
      `SELECT id FROM companies WHERE organization_id = $1 AND LOWER(name) = LOWER($2)`,
      [orgId, customerName]
    );
    assert(companyRes.rows.length === 1, `Expected 1 auto-created company, got ${companyRes.rows.length}`);
    track("companies", companyRes.rows[0].id);
    assert(opps[0].companyId === companyRes.rows[0].id, `AF opp companyId should match the auto-created company`);
  });

  // (h) Create-time-won path: a quote can be POSTed already in a "won" state
  //     (e.g. manual rep entry of a closed deal, CSV backfill). The AF
  //     handoff must run from createQuote too — not only from updateQuote
  //     — so the create-path behavior contract is preserved.
  await runTest("Quote created already in 'won' state with same-day pickup also produces an AF row", async () => {
    const fix = await createCustomerAndCompany(orgId);
    const requestDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const { status, json } = await apiPost("/api/customer-quotes/quote", cookie, {
      customerId: fix.customerId,
      originCity: "Chicago", originState: "IL",
      destCity: "Dallas", destState: "TX",
      equipment: "Dry Van",
      quotedAmount: 3100,
      carrierPaid: 2400,
      outcomeStatus: "won", // ← created already won
      source: "manual",
      requestDate,
    });
    assert(status === 201, `Create-as-won failed: ${status}`);
    const quoteId: string | undefined = json?.opp?.id ?? json?.id ?? json?.quote?.id;
    assert(!!quoteId, `No quote id in create-as-won response`);
    track("quote_opportunities", quoteId!);
    const opps = await afOppsForQuote(orgId, quoteId!);
    assert(opps.length === 1, `Expected 1 AF opp from create-as-won path, got ${opps.length}`);
    assert(opps[0].sourceRef?.type === "won_quote", `sourceRef.type should be won_quote`);
    assert(opps[0].companyId === fix.companyId, `companyId should match the resolved CRM company`);
  });

  // (e) Org setting OFF → handoff is short-circuited.
  await runTest("Org setting auto_won_quote_af_handoff = false short-circuits the AF handoff", async () => {
    const toggleOff = await apiPut("/api/customer-quotes/settings/auto-af-handoff", cookie, { enabled: false });
    assert(toggleOff.status === 200, `Toggle off failed: ${toggleOff.status}`);
    const fix = await createCustomerAndCompany(orgId);
    const quoteId = await createPendingQuote(cookie, fix.customerId, { pickupHoursFromNow: 24 });
    const { status } = await apiPatch(`/api/customer-quotes/quote/${quoteId}`, cookie, {
      outcomeStatus: "won",
    });
    assert(status === 200, `PATCH won failed: ${status}`);
    const opps = await afOppsForQuote(orgId, quoteId);
    assert(opps.length === 0, `Expected 0 AF opps when setting is off, got ${opps.length}`);
    // The LWQ handoff is intentionally NOT gated by this setting; verify it
    // still fires so toggling AF off doesn't accidentally suppress LWQ.
    const lanes = await lanesForQuote(quoteId);
    assert(lanes.length === 1, `Expected LWQ lane to still be created when AF is off, got ${lanes.length}`);

    // Restore for any subsequent tests (and cleanup also nukes the row).
    const toggleOn = await apiPut("/api/customer-quotes/settings/auto-af-handoff", cookie, { enabled: true });
    assert(toggleOn.status === 200, `Toggle on failed: ${toggleOn.status}`);
  });

  await cleanup(orgId);

  const failed = results.filter(r => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  await pool.end();
}

main().catch(async err => {
  console.error("Fatal:", err);
  try { await cleanup(await getDefaultOrgId()); } catch {}
  await pool.end().catch(() => {});
  process.exit(1);
});
