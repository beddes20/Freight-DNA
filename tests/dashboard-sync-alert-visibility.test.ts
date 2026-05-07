/**
 * Task #1108 — Dashboard sync alert visibility.
 *
 * Asserts that GET /api/dashboard/summary returns the syncAlert payload to
 * non-admin callers (account_manager). The "Upload manually" CTA is gated on
 * the client; the server payload itself is now role-agnostic.
 *
 * Run: npx tsx tests/dashboard-sync-alert-visibility.test.ts
 * Requires the dev server on port 5000.
 */

import http from "http";
import pg from "pg";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { storage } from "../server/storage";

const SERVER_HOST = "localhost";
const SERVER_PORT = 5000;

interface TestResult { name: string; passed: boolean; error?: string }
const results: TestResult[] = [];
const cleanupUserIds: string[] = [];

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

async function loginAs(username: string, password: string): Promise<string> {
  const body = JSON.stringify({ username, password });
  const res = await httpRequest({
    method: "POST",
    path: "/api/auth/login",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (res.status !== 200) throw new Error(`Login failed: ${res.status} ${res.body}`);
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = cookies.find(c => c.startsWith("connect.sid"))?.split(";")[0];
  if (!cookie) throw new Error("No session cookie returned by login");
  return cookie;
}

async function apiGet(path: string, cookie: string): Promise<{ status: number; json: any }> {
  const res = await httpRequest({ method: "GET", path, headers: { Cookie: cookie } });
  let json: any;
  try { json = JSON.parse(res.body); } catch { json = res.body; }
  return { status: res.status, json };
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    results.push({ name, passed: true });
    console.log(`  ✓ ${name}`);
  } else {
    results.push({ name, passed: false, error: detail });
    console.log(`  ✗ ${name}${detail ? `: ${detail}` : ""}`);
  }
}

async function getDefaultOrgId(): Promise<string> {
  const res = await pool.query("SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1");
  if (res.rows.length === 0) throw new Error("No organizations found");
  return res.rows[0].id as string;
}

async function createAmUser(orgId: string): Promise<{ id: string; username: string; password: string }> {
  const id = crypto.randomUUID();
  const password = `Pass${id.slice(0, 8)}!`;
  const hash = await bcrypt.hash(password, 10);
  const username = `dash.sync.test.${id.slice(0, 8)}@example.com`;
  await pool.query(
    `INSERT INTO users (id, organization_id, username, password, name, role, created_at)
     VALUES ($1, $2, $3, $4, $5, 'account_manager', NOW())`,
    [id, orgId, username, hash, `DashSyncTest ${id.slice(0, 6)}`]
  );
  cleanupUserIds.push(id);
  return { id, username, password };
}

async function cleanup(): Promise<void> {
  for (const id of cleanupUserIds) {
    await pool.query(`DELETE FROM monitored_mailboxes WHERE user_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
  }
}

async function main() {
  console.log("\nDashboard syncAlert visibility — Task #1108\n");

  // Snapshot any existing setting values so we can restore them at the end.
  const priorFailed = (await storage.getSetting("monthly_sync_failed")) ?? "";
  const priorErr = (await storage.getSetting("monthly_sync_failed_error")) ?? "";

  const orgId = await getDefaultOrgId();
  const am = await createAmUser(orgId);

  try {
    // Case 1: setting is set → AM sees the failure payload.
    await storage.setSetting("monthly_sync_failed", "2026-05");
    await storage.setSetting("monthly_sync_failed_error", "OneDrive token expired");
    {
      const cookie = await loginAs(am.username, am.password);
      const { status, json } = await apiGet("/api/dashboard/summary", cookie);
      assert("non-admin sees sync failure: status 200", status === 200, `got ${status}`);
      const sa = json?.syncAlert;
      assert(
        "non-admin sees sync failure: syncAlert.failed === true",
        sa?.failed === true,
        `syncAlert=${JSON.stringify(sa)}`
      );
      assert(
        "non-admin sees sync failure: month === '2026-05'",
        sa?.month === "2026-05",
        `month=${sa?.month}`
      );
      assert(
        "non-admin sees sync failure: error === 'OneDrive token expired'",
        sa?.error === "OneDrive token expired",
        `error=${sa?.error}`
      );
    }

    // Case 2: setting is empty → AM sees { failed: false }.
    await storage.setSetting("monthly_sync_failed", "");
    await storage.setSetting("monthly_sync_failed_error", "");
    {
      const cookie = await loginAs(am.username, am.password);
      const { status, json } = await apiGet("/api/dashboard/summary", cookie);
      assert("non-admin (no failure): status 200", status === 200, `got ${status}`);
      const sa = json?.syncAlert;
      assert(
        "non-admin (no failure): syncAlert.failed === false",
        sa?.failed === false,
        `syncAlert=${JSON.stringify(sa)}`
      );
      assert(
        "non-admin (no failure): no month leaked",
        sa?.month === undefined,
        `month=${sa?.month}`
      );
    }
  } finally {
    // Restore prior settings exactly.
    await storage.setSetting("monthly_sync_failed", priorFailed);
    await storage.setSetting("monthly_sync_failed_error", priorErr);
    await cleanup();
    await pool.end();
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(async err => {
  console.error(err);
  try { await cleanup(); } catch {}
  try { await pool.end(); } catch {}
  process.exit(1);
});
