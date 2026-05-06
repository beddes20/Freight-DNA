/**
 * Conversations Freshness Regression — Phase 1
 *
 * "Stop lying about freshness."
 *
 * Asserts that the source-of-truth freshness clock the Conversations UI
 * consumes (`lastEmailAt` on the list endpoint response) actually equals
 * MAX(email_messages.provider_sent_at) for that thread, within ±5s of
 * tolerance for tz / serialization rounding.
 *
 * Background. The thread-row UI used to render "Updated {formatAgo(thread.updatedAt)}",
 * but `email_conversation_threads.updated_at` is a row-touched-by-anything
 * clock — bumped by background workers (archive sweep, denormalization
 * sweeps, signal rewrites) on every pass — so 87% of bumps were noise and
 * the average drift was +134h vs the actual conversation activity. Phase 1
 * replaced that label with two precise email-activity timestamps and added
 * a server-computed `lastEmailAt` field. This test fences the seam: the API
 * must return the real MAX(provider_sent_at) and never silently regress to
 * `updated_at` again.
 *
 * Run with: npx tsx tests/conversations-freshness-regression.test.ts
 */

import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required to run this test");
  process.exit(1);
}

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:5000";
const TOLERANCE_MS = 5_000;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    const msg = detail ? `  ✗ ${description}\n    ${detail}` : `  ✗ ${description}`;
    console.error(msg);
    failures.push(description + (detail ? ` — ${detail}` : ""));
    failed++;
  }
}

interface ApiThread {
  id: string;
  threadId: string | null;
  orgId: string;
  updatedAt: string;
  lastIncomingAt: string | null;
  lastOutgoingAt: string | null;
  lastEmailAt: string | null;
}

async function fetchListPage(): Promise<ApiThread[] | null> {
  // The /api/internal/conversations endpoint is auth-gated. In the dev
  // environment, server/auth.ts has an `if (!IS_PROD)` block that bypasses
  // Clerk for the seeded dev session. If that bypass isn't active, the
  // endpoint returns 401 and we fall back to a DB-only assertion (still
  // verifies the runMigrations backfill, just not the route enrichment).
  try {
    const res = await fetch(`${BASE_URL}/api/internal/conversations?limit=50`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      console.warn(`  ! /api/internal/conversations returned ${res.status} — falling back to DB-only assertions`);
      return null;
    }
    const body = await res.json() as { threads?: ApiThread[] };
    return Array.isArray(body.threads) ? body.threads : null;
  } catch (err) {
    console.warn("  ! list endpoint fetch failed, falling back to DB-only assertions:", err);
    return null;
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });

  console.log("\n── Phase 1: lastEmailAt equals MAX(provider_sent_at) ────────────────\n");

  const apiThreads = await fetchListPage();

  if (apiThreads && apiThreads.length > 0) {
    // Validate against the live API response.
    const threadIds = apiThreads.map(t => t.threadId).filter((x): x is string => !!x);
    const orgIds = [...new Set(apiThreads.map(t => t.orgId).filter(Boolean))];

    const { rows } = await pool.query<{ thread_id: string; org_id: string; max_sent: Date | null }>(
      `SELECT thread_id, org_id, MAX(provider_sent_at) AS max_sent
         FROM email_messages
        WHERE thread_id = ANY($1::text[])
          AND org_id    = ANY($2::text[])
          AND provider_sent_at IS NOT NULL
        GROUP BY thread_id, org_id`,
      [threadIds, orgIds],
    );
    const dbMax = new Map<string, Date>();
    for (const r of rows) {
      if (r.max_sent) dbMax.set(`${r.org_id}::${r.thread_id}`, new Date(r.max_sent));
    }

    let checked = 0;
    let drift = 0;
    for (const t of apiThreads) {
      if (!t.threadId) continue;
      const key = `${t.orgId}::${t.threadId}`;
      const expected = dbMax.get(key);
      if (!expected) continue; // No messages on this thread — defensive fallback path; covered separately.
      checked++;
      const apiTs = t.lastEmailAt ? new Date(t.lastEmailAt).getTime() : 0;
      const expectedTs = expected.getTime();
      if (Math.abs(apiTs - expectedTs) > TOLERANCE_MS) {
        drift++;
        if (drift <= 5) {
          console.error(
            `    drift on thread ${t.threadId}: ` +
            `api lastEmailAt=${t.lastEmailAt}, db MAX(provider_sent_at)=${expected.toISOString()}`,
          );
        }
      }
    }
    assert(
      `API lastEmailAt matches MAX(provider_sent_at) within ±${TOLERANCE_MS}ms (${checked} threads checked)`,
      checked === 0 || drift === 0,
      drift > 0 ? `${drift}/${checked} threads drifted` : undefined,
    );

    // Also assert the new field is actually present on every row so the
    // UI never sees `undefined` and falls back to updatedAt by mistake.
    const missingField = apiThreads.filter(t => !("lastEmailAt" in t));
    assert(
      "Every API thread row exposes the lastEmailAt field",
      missingField.length === 0,
      missingField.length > 0 ? `${missingField.length} rows missing lastEmailAt` : undefined,
    );
  } else {
    console.log("  ! Skipping live-API assertions (endpoint unreachable / no threads in dev DB)");
  }

  // ── DB-level invariant — runMigrations backfill landed correctly ────────
  console.log("\n── Phase 1: runMigrations backfill anchors thread cols to provider_sent_at ──\n");

  // For every thread that has at least one inbound provider_sent_at, the
  // denormalized column must equal that MAX (within tolerance). Same for
  // outbound. If this fails, the runMigrations backfill regressed.
  const driftRows = await pool.query<{ violations: string }>(
    `WITH msg_max AS (
       SELECT thread_id, org_id,
              MAX(provider_sent_at) FILTER (WHERE direction = 'inbound')  AS max_in,
              MAX(provider_sent_at) FILTER (WHERE direction = 'outbound') AS max_out
         FROM email_messages
        WHERE provider_sent_at IS NOT NULL
          AND thread_id IS NOT NULL
        GROUP BY thread_id, org_id
     )
     SELECT COUNT(*)::text AS violations
       FROM email_conversation_threads ect
       JOIN msg_max m ON m.thread_id = ect.thread_id AND m.org_id = ect.org_id
      WHERE (m.max_in  IS NOT NULL AND (ect.last_incoming_at IS NULL OR ABS(EXTRACT(EPOCH FROM (ect.last_incoming_at - m.max_in)))  > 5))
         OR (m.max_out IS NOT NULL AND (ect.last_outgoing_at IS NULL OR ABS(EXTRACT(EPOCH FROM (ect.last_outgoing_at - m.max_out))) > 5))`,
  );
  const violations = parseInt(driftRows.rows[0]?.violations ?? "0", 10);
  assert(
    "Every thread's last_incoming_at / last_outgoing_at matches MAX(provider_sent_at) per direction",
    violations === 0,
    violations > 0
      ? `${violations} thread row(s) drifted by >5s — runMigrations conversations-freshness backfill is not landing`
      : undefined,
  );

  // ─────────────────────────────────────────────────────────────────────
  // Task #858 — Date-filter seam from the *display* side.
  //
  // For any thread returned by ?dateFrom=today&dateTo=today, the
  // API-shipped `lastEmailAt` must land inside the rep-local today
  // window. If it doesn't, either the storage filter regressed (back
  // to anchoring on `updated_at`) or the route layer's tz resolution
  // drifted away from the row label. Both are visible-to-the-rep bugs.
  // ─────────────────────────────────────────────────────────────────────
  console.log("\n── Phase 1+: ?dateFrom=today&dateTo=today only returns rows whose lastEmailAt is in today (Task #858) ──\n");
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const todayStr = `${yyyy}-${mm}-${dd}`;
    const localStart = new Date(yyyy, now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const localEnd = new Date(yyyy, now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const qs = new URLSearchParams({
      dateFrom: todayStr,
      dateTo: todayStr,
      tz,
      limit: "100",
    });
    const r = await fetch(`${BASE_URL}/api/internal/conversations?${qs.toString()}`, {
      headers: { Accept: "application/json" },
    });
    if (!r.ok) {
      console.warn(`  ! /api/internal/conversations returned ${r.status} — skipping date-filter seam check`);
    } else {
      const body = (await r.json()) as { threads?: ApiThread[] };
      const rows = Array.isArray(body.threads) ? body.threads : [];
      let outsideWindow = 0;
      let firstOffender: ApiThread | null = null;
      for (const t of rows) {
        if (!t.lastEmailAt) continue;
        const ts = new Date(t.lastEmailAt);
        if (ts < localStart || ts > localEnd) {
          outsideWindow++;
          if (!firstOffender) firstOffender = t;
        }
      }
      assert(
        `Every today-window row's lastEmailAt is inside the rep-local today window (${rows.length} threads checked)`,
        outsideWindow === 0,
        firstOffender
          ? `Row ${firstOffender.threadId} has lastEmailAt=${firstOffender.lastEmailAt} which is outside ` +
            `[${localStart.toISOString()}, ${localEnd.toISOString()}] — see Task #858`
          : undefined,
      );
    }
  } catch (err) {
    console.warn("  ! date-filter seam check skipped:", err);
  }

  await pool.end();

  console.log(`\n── Results: ${passed} passed, ${failed} failed ──────────────────────────────────\n`);
  if (failures.length > 0) {
    console.error("Failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
