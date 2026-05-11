#!/usr/bin/env tsx
/**
 * Post-publish acceptance check for the FreightDNA prod restore + republish
 * window. Read-only. Bundles the automatable parts of Block A + Block B from
 * `docs/operator-maintenance-window-checklist-2026-05-08.md` Step 5.
 *
 * Usage:
 *   DATABASE_URL=postgres://...prod... \
 *   tsx scripts/post-publish-acceptance-check.ts \
 *     --since-restart 2026-05-04T00:00:00Z \
 *     --org da3ed822-8846-4435-bb13-3cc4bf26f71d
 *
 * Block A (deploy-log scans for `duplicate key value violates unique
 * constraint`) is owned by the agent's `fetchDeploymentLogs` calls during the
 * window — not in this script — because it queries Replit's log pipeline,
 * not the DB.
 *
 * This script never writes. Exit codes:
 *   0 = all checks pass
 *   1 = at least one check failed
 *   2 = script could not run (bad inputs, DB unreachable, etc.)
 */
import { Pool } from "pg";

type CheckResult = {
  name: string;
  pass: boolean;
  detail: string;
};

function parseArgs(argv: string[]): {
  sinceRestart: string | null;
  org: string | null;
} {
  const out: { sinceRestart: string | null; org: string | null } = {
    sinceRestart: null,
    org: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since-restart") out.sinceRestart = argv[++i] ?? null;
    else if (a === "--org") out.org = argv[++i] ?? null;
  }
  return out;
}

function isIsoTimestamp(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s,
  );
}

async function checkSchemaPresence(pool: Pool): Promise<CheckResult[]> {
  const tables = [
    "crm_opportunities",
    "prospects",
    "company_financial_aliases",
    "user_lifecycle_events",
  ];
  const columns: Array<[string, string]> = [
    ["companies", "is_email_derived"],
    ["users", "is_active"],
    ["users", "deleted_at"],
    ["users", "is_service_account"],
    ["users", "is_quarantined"],
  ];

  const results: CheckResult[] = [];

  for (const t of tables) {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
      [t],
    );
    results.push({
      name: `schema: table public.${t}`,
      pass: r.rowCount === 1,
      detail: r.rowCount === 1 ? "present" : "MISSING",
    });
  }

  for (const [t, c] of columns) {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`,
      [t, c],
    );
    results.push({
      name: `schema: column public.${t}.${c}`,
      pass: r.rowCount === 1,
      detail: r.rowCount === 1 ? "present" : "MISSING",
    });
  }

  return results;
}

async function checkDuplicateQoGroups(
  pool: Pool,
  org: string,
  sinceRestart: string,
): Promise<CheckResult> {
  // Block B: post-restart QO duplicate check
  const r = await pool.query(
    `SELECT count(*)::int AS dup_groups FROM (
       SELECT source_reference
       FROM quote_opportunities
       WHERE organization_id = $1
         AND created_at > $2
         AND source_reference IS NOT NULL
       GROUP BY source_reference
       HAVING count(*) > 1
     ) t`,
    [org, sinceRestart],
  );
  const dupGroups = (r.rows[0]?.dup_groups ?? 0) as number;
  return {
    name: `block-B: dup-QO groups since ${sinceRestart}`,
    pass: dupGroups === 0,
    detail:
      dupGroups === 0
        ? "0 duplicate groups (race fix live)"
        : `${dupGroups} duplicate groups found — race fix may not be live`,
  };
}

async function checkPipelineFlowing(
  pool: Pool,
  org: string,
  sinceRestart: string,
): Promise<CheckResult[]> {
  const emails = await pool.query(
    `SELECT count(*)::int AS n FROM email_messages
     WHERE org_id = $1 AND created_at > $2`,
    [org, sinceRestart],
  );
  const qos = await pool.query(
    `SELECT count(*)::int AS n FROM quote_opportunities
     WHERE organization_id = $1 AND created_at > $2`,
    [org, sinceRestart],
  );
  const emailN = (emails.rows[0]?.n ?? 0) as number;
  const qoN = (qos.rows[0]?.n ?? 0) as number;
  return [
    {
      name: `block-B: email_messages since ${sinceRestart}`,
      pass: emailN > 0,
      detail: `${emailN} new emails`,
    },
    {
      name: `block-B: quote_opportunities since ${sinceRestart}`,
      pass: qoN > 0,
      detail: `${qoN} new QOs`,
    },
  ];
}

async function checkOrphanQos(
  pool: Pool,
  org: string,
): Promise<CheckResult> {
  // Pre-window known orphan count was 6 (per audit_results.md). We report
  // the current count and flag a regression if it grew past 6 — operator
  // makes the call.
  const PRE_WINDOW_ORPHAN_COUNT = 6;
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM quote_opportunities
     WHERE organization_id = $1 AND customer_id IS NULL`,
    [org],
  );
  const n = (r.rows[0]?.n ?? 0) as number;
  return {
    name: `orphan-QO count`,
    pass: n <= PRE_WINDOW_ORPHAN_COUNT,
    detail:
      n <= PRE_WINDOW_ORPHAN_COUNT
        ? `${n} orphans (pre-window: ${PRE_WINDOW_ORPHAN_COUNT}; not regressed)`
        : `${n} orphans (REGRESSED from pre-window ${PRE_WINDOW_ORPHAN_COUNT})`,
  };
}

function printResults(results: CheckResult[]): boolean {
  let allPass = true;
  console.log("");
  console.log("── Post-publish acceptance check ─────────────────────────────");
  for (const r of results) {
    const tag = r.pass ? "PASS" : "FAIL";
    console.log(`  [${tag}] ${r.name} — ${r.detail}`);
    if (!r.pass) allPass = false;
  }
  console.log("──────────────────────────────────────────────────────────────");
  console.log(allPass ? "OVERALL: PASS" : "OVERALL: FAIL");
  console.log("");
  if (!allPass) {
    console.log(
      "Per docs/operator-maintenance-window-checklist-2026-05-08.md Step 5:",
    );
    console.log(
      "  - Block A failures (dup-key log matches): scan deploy logs with",
    );
    console.log(
      "    fetchDeploymentLogs and treat as a blocker for declaring success.",
    );
    console.log(
      "  - Block B failures: do NOT declare the window successful.",
    );
    console.log(
      "  - Block C (high-value account UI verification): operator-owned.",
    );
  }
  return allPass;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sinceRestart || !args.org) {
    console.error(
      "Usage: tsx scripts/post-publish-acceptance-check.ts --since-restart <UTC ISO> --org <uuid>",
    );
    console.error(
      "  --since-restart  Step 7 restart timestamp from the operator checklist",
    );
    console.error("  --org            Organization UUID to scope SELECTs");
    process.exit(2);
  }
  if (!isIsoTimestamp(args.sinceRestart)) {
    console.error(
      `--since-restart must be a UTC ISO timestamp (e.g. 2026-05-04T00:00:00Z), got: ${args.sinceRestart}`,
    );
    process.exit(2);
  }
  if (!isUuid(args.org)) {
    console.error(`--org must be a UUID, got: ${args.org}`);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set. Point it at the database you want to check (typically prod after publish).",
    );
    process.exit(2);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const results: CheckResult[] = [];
    results.push(...(await checkSchemaPresence(pool)));
    results.push(
      await checkDuplicateQoGroups(pool, args.org, args.sinceRestart),
    );
    results.push(
      ...(await checkPipelineFlowing(pool, args.org, args.sinceRestart)),
    );
    results.push(await checkOrphanQos(pool, args.org));

    const ok = printResults(results);
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error("[post-publish-acceptance-check] crashed:", err);
    process.exit(2);
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
