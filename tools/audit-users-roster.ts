/**
 * Subtask A — Read-only Users Roster audit.
 *
 * Calls the existing Phase 0 classifier (`getRosterHealthSnapshot`) per
 * organization and renders a markdown report with per-bucket counts plus
 * the "default-roster leakage" cohort = users currently visible in
 * `GET /api/users` (i.e. would pass the Section 1126 lifecycle filter)
 * BUT classified as `likely_junk` / `likely_demo_fixture` /
 * `likely_service_shared_inbox`.
 *
 * Strict zero-write contract: SELECT-only. No code path inserts or updates.
 *
 * Usage:
 *   npx tsx tools/audit-users-roster.ts
 */

import { sql } from "drizzle-orm";
import { db } from "../server/storage";
import {
  getRosterHealthSnapshot,
  ROSTER_BUCKETS,
  ROSTER_BUCKET_LABELS,
  type ClassifiedUser,
  type RosterBucket,
} from "../server/lib/userRosterClassification";

const SAMPLES_PER_BUCKET = 8;
const LEAKAGE_BUCKETS: ReadonlySet<RosterBucket> = new Set<RosterBucket>([
  "likely_junk",
  "likely_demo_fixture",
  "likely_service_shared_inbox",
]);

interface OrgRow {
  id: string;
  name: string;
  slug: string;
}

interface LeakageRow extends ClassifiedUser {
  passesDefaultFilter: boolean;
}

async function listOrgs(): Promise<OrgRow[]> {
  const rows = await db.execute<{ id: string; name: string; slug: string; user_count: string }>(sql`
    SELECT o.id, o.name, o.slug,
      (SELECT count(*) FROM users u WHERE u.organization_id = o.id) AS user_count
    FROM organizations o
    ORDER BY (SELECT count(*) FROM users u WHERE u.organization_id = o.id) DESC
  `);
  return rows.rows.map(r => ({ id: r.id, name: r.name, slug: r.slug }));
}

/**
 * Returns the set of user IDs that would be visible in the *current*
 * default `GET /api/users` view: lifecycle clean per Section 1126.4
 * (active, not deleted, not service, not quarantined, not demo,
 * not fixture).
 */
async function getDefaultVisibleIds(orgId: string): Promise<Set<string>> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM users
    WHERE organization_id = ${orgId}
      AND deleted_at IS NULL
      AND COALESCE(is_active, true) = true
      AND COALESCE(is_service_account, false) = false
      AND COALESCE(is_quarantined, false) = false
      AND COALESCE(is_demo, false) = false
      AND COALESCE(is_fixture, false) = false
  `);
  return new Set(rows.rows.map(r => r.id));
}

function fmtUser(u: ClassifiedUser): string {
  const last = u.lastLoginAt ? u.lastLoginAt.slice(0, 10) : "never";
  const created = u.createdAt ? u.createdAt.slice(0, 10) : "?";
  const sigs = u.signals.slice(0, 4).join(", ") || "—";
  return `  - \`${u.id}\` — **${u.username}** — name=\`${u.name}\` role=${u.role} lastLogin=${last} created=${created} signals=[${sigs}] reason=${u.reason}`;
}

async function auditOrg(org: OrgRow, visibleIds: Set<string>): Promise<{
  org: OrgRow;
  totalUsers: number;
  bucketCounts: Record<RosterBucket, number>;
  defaultVisible: number;
  leakage: LeakageRow[];
  samplesByBucket: Record<RosterBucket, ClassifiedUser[]>;
}> {
  const snap = await getRosterHealthSnapshot(org.id);

  // Decorate with default-filter passage.
  const decorated: LeakageRow[] = snap.users.map(u => ({
    ...u,
    passesDefaultFilter: visibleIds.has(u.id),
  }));

  // Leakage = passes default filter AND in a cleanup bucket.
  const leakage = decorated.filter(
    u => u.passesDefaultFilter && LEAKAGE_BUCKETS.has(u.bucket),
  );

  const samplesByBucket = ROSTER_BUCKETS.reduce<Record<RosterBucket, ClassifiedUser[]>>(
    (acc, b) => {
      acc[b] = decorated
        .filter(u => u.bucket === b)
        .sort((a, b2) => b2.reviewPriority - a.reviewPriority || a.name.localeCompare(b2.name))
        .slice(0, SAMPLES_PER_BUCKET);
      return acc;
    },
    {} as Record<RosterBucket, ClassifiedUser[]>,
  );

  return {
    org,
    totalUsers: snap.totalUsers,
    bucketCounts: snap.bucketCounts,
    defaultVisible: visibleIds.size,
    leakage,
    samplesByBucket,
  };
}

function renderOrg(report: Awaited<ReturnType<typeof auditOrg>>): string {
  const lines: string[] = [];
  const { org, totalUsers, bucketCounts, defaultVisible, leakage, samplesByBucket } = report;
  lines.push(`## Org: ${org.name}  \`${org.slug}\``);
  lines.push(``);
  lines.push(`- organization_id: \`${org.id}\``);
  lines.push(`- total users: **${totalUsers}**`);
  lines.push(`- pass current default \`GET /api/users\` filter: **${defaultVisible}**`);
  lines.push(`- **default-roster leakage** (visible today AND classifier flags as junk / demo-fixture / service): **${leakage.length}**`);
  lines.push(``);
  lines.push(`### Bucket counts`);
  lines.push(``);
  lines.push(`| Bucket | Label | Count |`);
  lines.push(`|---|---|---:|`);
  for (const b of ROSTER_BUCKETS) {
    lines.push(`| \`${b}\` | ${ROSTER_BUCKET_LABELS[b]} | ${bucketCounts[b]} |`);
  }
  lines.push(``);

  if (leakage.length > 0) {
    lines.push(`### Default-roster leakage examples (top ${Math.min(leakage.length, SAMPLES_PER_BUCKET * 2)})`);
    lines.push(``);
    const top = leakage
      .slice()
      .sort((a, b) => b.reviewPriority - a.reviewPriority || a.name.localeCompare(b.name))
      .slice(0, SAMPLES_PER_BUCKET * 2);
    for (const u of top) {
      lines.push(fmtUser(u));
    }
    lines.push(``);
  }

  lines.push(`### Bucket samples (top ${SAMPLES_PER_BUCKET} per bucket by reviewPriority)`);
  lines.push(``);
  for (const b of ROSTER_BUCKETS) {
    const rows = samplesByBucket[b];
    if (rows.length === 0) continue;
    lines.push(`#### \`${b}\` — ${ROSTER_BUCKET_LABELS[b]}  (showing ${rows.length} of ${bucketCounts[b]})`);
    lines.push(``);
    for (const u of rows) {
      const visMarker = LEAKAGE_BUCKETS.has(b) && (u as LeakageRow).passesDefaultFilter ? " 🚨 LEAKING" : "";
      lines.push(fmtUser(u) + visMarker);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const orgs = await listOrgs();
  console.log(`[audit-users-roster] ${orgs.length} orgs found`);

  const reports: Awaited<ReturnType<typeof auditOrg>>[] = [];
  for (const org of orgs) {
    const visibleIds = await getDefaultVisibleIds(org.id);
    const r = await auditOrg(org, visibleIds);
    reports.push(r);
    console.log(`[audit-users-roster] ${org.slug}: total=${r.totalUsers} visible=${r.defaultVisible} leakage=${r.leakage.length}`);
  }

  // Aggregate roll-up.
  const totals = reports.reduce(
    (acc, r) => {
      acc.totalUsers += r.totalUsers;
      acc.defaultVisible += r.defaultVisible;
      acc.leakage += r.leakage.length;
      for (const b of ROSTER_BUCKETS) acc.bucketCounts[b] += r.bucketCounts[b];
      return acc;
    },
    {
      totalUsers: 0,
      defaultVisible: 0,
      leakage: 0,
      bucketCounts: ROSTER_BUCKETS.reduce<Record<RosterBucket, number>>((a, b) => {
        a[b] = 0;
        return a;
      }, {} as Record<RosterBucket, number>),
    },
  );

  const md: string[] = [];
  md.push(`# Users Roster Audit — ${today}`);
  md.push(``);
  md.push(`**Subtask A of the Users Trust Cleanup Program.** Read-only snapshot from the existing Phase 0 \`getRosterHealthSnapshot\` classifier (\`server/lib/userRosterClassification.ts\`). No writes; no schema; no flag flips.`);
  md.push(``);
  md.push(`**"Default-roster leakage"** = users who currently pass the existing \`GET /api/users\` default filter (Section 1126 Phase 1 Step 4a-API: lifecycle-clean) BUT are classified as one of \`likely_junk\` / \`likely_demo_fixture\` / \`likely_service_shared_inbox\`. These are the rows Subtask B's read-time pattern filter would newly hide.`);
  md.push(``);
  md.push(`---`);
  md.push(``);
  md.push(`## All-org rollup`);
  md.push(``);
  md.push(`- orgs scanned: **${reports.length}**`);
  md.push(`- total users (all orgs): **${totals.totalUsers}**`);
  md.push(`- pass default filter (all orgs): **${totals.defaultVisible}**`);
  md.push(`- **leakage (all orgs)**: **${totals.leakage}**`);
  md.push(``);
  md.push(`| Bucket | Label | Count |`);
  md.push(`|---|---|---:|`);
  for (const b of ROSTER_BUCKETS) {
    md.push(`| \`${b}\` | ${ROSTER_BUCKET_LABELS[b]} | ${totals.bucketCounts[b]} |`);
  }
  md.push(``);
  md.push(`---`);
  md.push(``);

  for (const r of reports) {
    if (r.totalUsers === 0) continue;
    md.push(renderOrg(r));
    md.push(``);
    md.push(`---`);
    md.push(``);
  }

  md.push(`## Notes`);
  md.push(``);
  md.push(`- Source classifier: \`server/lib/userRosterClassification.ts\` (read-only, Phase 0).`);
  md.push(`- Default filter shape mirrors \`storage.getUsers\` Section 1126 Phase 1 Step 4a-API.`);
  md.push(`- This audit does NOT mutate \`is_fixture\` / \`is_demo\` / any lifecycle flag.`);
  md.push(`- Subtask B will add a read-time pattern exclusion (no writes) for the leakage cohort, plus an admin-only \`?includeJunkSuspects=true\` opt-in.`);
  md.push(``);

  const path = `docs/users-bucket-audit-${today}.md`;
  const fs = await import("node:fs/promises");
  await fs.writeFile(path, md.join("\n"), "utf8");
  console.log(`\n[audit-users-roster] wrote ${path}  (${md.length} lines)`);
  process.exit(0);
}

main().catch(err => {
  console.error("[audit-users-roster] FAILED:", err);
  process.exit(1);
});
