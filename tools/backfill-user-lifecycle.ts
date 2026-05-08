/**
 * Task #1126 Phase 1 step 2 — observational user-lifecycle backfill.
 *
 * Populates ONLY two columns on `users`:
 *   - user_source       (clerk | seed | unknown — see derivation below)
 *   - last_activity_at  (GREATEST of activity-table timestamps)
 *
 * Strict scope (stop rule):
 *   - DRY-RUN by default. Pass `--apply` to write.
 *   - NEVER writes is_active, is_service_account, is_demo, is_fixture,
 *     is_quarantined, deleted_at/deleted_by/delete_reason, or
 *     deactivated_at/deactivated_by/deactivation_reason.
 *   - NEVER reads or modifies any production code path; this is a CLI.
 *   - Idempotent: re-running with no new activity is a no-op
 *     (`column IS DISTINCT FROM new_value` guard).
 *
 * Usage:
 *   npx tsx tools/backfill-user-lifecycle.ts                  # all orgs, dry-run
 *   npx tsx tools/backfill-user-lifecycle.ts --apply          # all orgs, write
 *   npx tsx tools/backfill-user-lifecycle.ts --org=<uuid>     # one org, dry-run
 *   npx tsx tools/backfill-user-lifecycle.ts --org=<uuid> --apply
 *   npx tsx tools/backfill-user-lifecycle.ts --limit=10       # sample rows printed per org
 */

import { sql } from "drizzle-orm";
import { db } from "../server/storage";

interface Args {
  apply: boolean;
  org: string | null;
  sampleLimit: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false, org: null, sampleLimit: 5 };
  for (const a of argv.slice(2)) {
    if (a === "--apply") out.apply = true;
    else if (a.startsWith("--org=")) out.org = a.slice("--org=".length).trim() || null;
    else if (a.startsWith("--limit=")) {
      const n = parseInt(a.slice("--limit=".length), 10);
      if (Number.isFinite(n) && n > 0) out.sampleLimit = n;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: backfill-user-lifecycle [--apply] [--org=<uuid>] [--limit=<n>]\n" +
          "  Default is DRY-RUN. Pass --apply to write user_source and last_activity_at.",
      );
      process.exit(0);
    } else {
      console.error(`[backfill-user-lifecycle] unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

// ── user_source derivation ─────────────────────────────────────────
// Conservative per stop rule: only mark a source we can prove from the
// row's own evidence. Everything else stays `unknown` until a richer
// signal lands. We never invent `bulk-import`, `email-derived`, or
// `manual-admin` here — those are valid future values but require
// markers that don't yet exist on the users table.

const SEED_USERNAME_PATTERNS: RegExp[] = [
  /^(wq|am)\.test\./i,
  /^am\.\d+/i,
  /@mailinator\.com$/i,
];

function deriveUserSource(row: { clerkUserId: string | null; username: string }): string {
  if (row.clerkUserId && row.clerkUserId.trim().length > 0) return "clerk";
  for (const re of SEED_USERNAME_PATTERNS) {
    if (re.test(row.username)) return "seed";
  }
  return "unknown";
}

// ── SQL: org-scoped read of every user with their derived columns ─
//
// last_activity_at is computed in Postgres (GREATEST + correlated maxes)
// so we never pull every activity row into Node memory. We deliberately
// EXCLUDE:
//   - users.last_login_at (login is its own axis, not "activity")
//   - companies.assigned_to (no per-assignment timestamp)
//   - freight_daily_upload_fact (no FK to users; heuristic match would
//     conflate organic freight with a user's own work)

interface OrgRow {
  id: string;
  organization_id: string;
  username: string;
  clerk_user_id: string | null;
  current_user_source: string | null;
  // pg may return timestamptz as Date OR ISO string depending on driver config.
  current_last_activity_at: Date | string | null;
  derived_last_activity_at: Date | string | null;
}

function toDate(v: Date | string | null): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface OrgSummary {
  orgId: string;
  scanned: number;
  sourceCounts: Record<string, number>;
  sourceChanges: number;
  activityChanges: number;
  unchangedActivity: number;
  samples: Array<{
    id: string;
    username: string;
    sourceFrom: string | null;
    sourceTo: string;
    activityFrom: Date | null;
    activityTo: Date | null;
  }>;
}

async function listOrgIds(filterOrg: string | null): Promise<string[]> {
  if (filterOrg) return [filterOrg];
  const r = await db.execute<{ id: string }>(sql`SELECT id FROM organizations ORDER BY id`);
  return r.rows.map((x) => x.id);
}

// Some dev DBs are behind on `drizzle-kit push:pg` so individual columns
// or whole activity tables may be missing. Probe once so the tool can
// degrade gracefully instead of crashing — production will always have
// every table/column after the standard pre-deploy push.
interface SchemaProbe {
  hasClerkUserId: boolean;
  hasUserSource: boolean;
  hasLastActivityAt: boolean;
  hasContextNotes: boolean;
  hasTouchpoints: boolean;
  hasCrmOpportunities: boolean;
  hasTasks: boolean;
}

async function detectSchema(): Promise<SchemaProbe> {
  const colsResult = await db.execute<{ column_name: string }>(sql`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users'
  `);
  const userCols = new Set(colsResult.rows.map((x) => x.column_name));
  const tablesResult = await db.execute<{ table_name: string }>(sql`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('context_notes','touchpoints','crm_opportunities','tasks')
  `);
  const tables = new Set(tablesResult.rows.map((x) => x.table_name));
  return {
    hasClerkUserId: userCols.has("clerk_user_id"),
    hasUserSource: userCols.has("user_source"),
    hasLastActivityAt: userCols.has("last_activity_at"),
    hasContextNotes: tables.has("context_notes"),
    hasTouchpoints: tables.has("touchpoints"),
    hasCrmOpportunities: tables.has("crm_opportunities"),
    hasTasks: tables.has("tasks"),
  };
}

let SCHEMA_PROBE: SchemaProbe | null = null;

async function processOrg(orgId: string, args: Args): Promise<OrgSummary> {
  const probe = SCHEMA_PROBE!;
  const clerkExpr = probe.hasClerkUserId ? sql`u.clerk_user_id` : sql`NULL::text`;
  const sourceExpr = probe.hasUserSource ? sql`u.user_source` : sql`NULL::text`;
  const activityExpr = probe.hasLastActivityAt ? sql`u.last_activity_at` : sql`NULL::timestamptz`;

  const activityParts: ReturnType<typeof sql>[] = [];
  if (probe.hasContextNotes) {
    activityParts.push(
      sql`(SELECT MAX(cn.created_at) FROM context_notes cn WHERE cn.author_id = u.id)`,
    );
  }
  if (probe.hasTouchpoints) {
    activityParts.push(
      sql`(SELECT MAX(t.created_at::timestamptz) FROM touchpoints t WHERE t.logged_by_id = u.id)`,
    );
  }
  if (probe.hasCrmOpportunities) {
    activityParts.push(
      sql`(SELECT MAX(o.updated_at) FROM crm_opportunities o WHERE o.created_by_id = u.id)`,
    );
  }
  if (probe.hasTasks) {
    activityParts.push(
      sql`(SELECT MAX(tk.created_at::timestamptz) FROM tasks tk WHERE tk.assigned_to = u.id)`,
    );
  }
  const derivedExpr =
    activityParts.length === 0
      ? sql`NULL::timestamptz`
      : sql`GREATEST(${sql.join(activityParts, sql`, `)})`;

  const r = await db.execute<OrgRow>(sql`
    SELECT
      u.id,
      u.organization_id,
      u.username,
      ${clerkExpr}    AS clerk_user_id,
      ${sourceExpr}   AS current_user_source,
      ${activityExpr} AS current_last_activity_at,
      ${derivedExpr}  AS derived_last_activity_at
    FROM users u
    WHERE u.organization_id = ${orgId}
    ORDER BY u.username
  `);
  const summary: OrgSummary = {
    orgId,
    scanned: r.rows.length,
    sourceCounts: { clerk: 0, seed: 0, unknown: 0 },
    sourceChanges: 0,
    activityChanges: 0,
    unchangedActivity: 0,
    samples: [],
  };

  for (const row of r.rows) {
    const newSource = deriveUserSource({
      clerkUserId: row.clerk_user_id,
      username: row.username,
    });
    summary.sourceCounts[newSource] = (summary.sourceCounts[newSource] ?? 0) + 1;

    const sourceWillChange = row.current_user_source !== newSource;
    const newActivity = toDate(row.derived_last_activity_at);
    const currentActivity = toDate(row.current_last_activity_at);
    const activityWillChange =
      (currentActivity?.getTime() ?? null) !== (newActivity?.getTime() ?? null);

    if (sourceWillChange) summary.sourceChanges += 1;
    if (activityWillChange) summary.activityChanges += 1;
    else summary.unchangedActivity += 1;

    if ((sourceWillChange || activityWillChange) && summary.samples.length < args.sampleLimit) {
      summary.samples.push({
        id: row.id,
        username: row.username,
        sourceFrom: row.current_user_source,
        sourceTo: newSource,
        activityFrom: currentActivity,
        activityTo: newActivity,
      });
    }

    if (
      args.apply &&
      (sourceWillChange || activityWillChange) &&
      probe.hasUserSource &&
      probe.hasLastActivityAt
    ) {
      // IS DISTINCT FROM keeps the UPDATE a true no-op when neither
      // value moved — supports safe re-runs after partial failures.
      await db.execute(sql`
        UPDATE users
           SET user_source      = ${newSource},
               last_activity_at = ${newActivity}
         WHERE id = ${row.id}
           AND (user_source      IS DISTINCT FROM ${newSource}
             OR last_activity_at IS DISTINCT FROM ${newActivity})
      `);
    }
  }

  return summary;
}

function fmtDate(d: Date | null): string {
  return d ? d.toISOString() : "null";
}

function printOrgSummary(s: OrgSummary): void {
  const counts = Object.entries(s.sourceCounts)
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");
  console.log(`[backfill-user-lifecycle] org=${s.orgId}   users=${s.scanned}`);
  console.log(`   user_source        ${counts}`);
  console.log(
    `   last_activity_at   would-set=${s.activityChanges}  unchanged=${s.unchangedActivity}`,
  );
  if (s.samples.length > 0) {
    console.log(`   sample (first ${s.samples.length} change(s)):`);
    for (const sample of s.samples) {
      console.log(
        `     id=${sample.id}  username=${sample.username}` +
          `  user_source: ${sample.sourceFrom ?? "null"}→${sample.sourceTo}` +
          `  last_activity_at: ${fmtDate(sample.activityFrom)}→${fmtDate(sample.activityTo)}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const mode = args.apply ? "APPLY" : "DRY-RUN";
  const scope = args.org ? `org=${args.org}` : "all-orgs";
  console.log(`[backfill-user-lifecycle] mode=${mode}  scope=${scope}`);

  SCHEMA_PROBE = await detectSchema();
  if (!SCHEMA_PROBE.hasUserSource || !SCHEMA_PROBE.hasLastActivityAt) {
    console.log(
      `[backfill-user-lifecycle] WARNING: users table is missing` +
        `${!SCHEMA_PROBE.hasUserSource ? " user_source" : ""}` +
        `${!SCHEMA_PROBE.hasLastActivityAt ? " last_activity_at" : ""}` +
        ` — run \`drizzle-kit push:pg\` (Phase 1 step 1 migration). Apply mode is disabled until then.`,
    );
    if (args.apply) {
      console.log(`[backfill-user-lifecycle] forcing DRY-RUN because target columns are missing`);
      args.apply = false;
    }
  }
  if (!SCHEMA_PROBE.hasClerkUserId) {
    console.log(
      `[backfill-user-lifecycle] note: users.clerk_user_id missing in this DB — every user will derive as user_source=seed/unknown`,
    );
  }
  const missingActivity = [
    !SCHEMA_PROBE.hasContextNotes && "context_notes",
    !SCHEMA_PROBE.hasTouchpoints && "touchpoints",
    !SCHEMA_PROBE.hasCrmOpportunities && "crm_opportunities",
    !SCHEMA_PROBE.hasTasks && "tasks",
  ].filter(Boolean) as string[];
  if (missingActivity.length > 0) {
    console.log(
      `[backfill-user-lifecycle] note: activity table(s) missing — ${missingActivity.join(", ")} — those signals will be ignored when computing last_activity_at`,
    );
  }

  const orgIds = await listOrgIds(args.org);
  if (orgIds.length === 0) {
    console.log(`[backfill-user-lifecycle] no organizations found for scope=${scope}`);
    return;
  }

  let totals = { scanned: 0, sourceChanges: 0, activityChanges: 0 };
  for (const orgId of orgIds) {
    const summary = await processOrg(orgId, args);
    printOrgSummary(summary);
    totals.scanned += summary.scanned;
    totals.sourceChanges += summary.sourceChanges;
    totals.activityChanges += summary.activityChanges;
  }

  console.log(
    `[backfill-user-lifecycle] TOTAL  users-scanned=${totals.scanned}` +
      `  user_source-changes=${totals.sourceChanges}` +
      `  last_activity-changes=${totals.activityChanges}` +
      `  applied=${args.apply}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-user-lifecycle] fatal:", err);
    process.exit(1);
  });
