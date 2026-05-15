/**
 * CONV-1.1-A — Read-only Conversations visibility audit.
 *
 * Quantifies the gap between "what threads a rep sees in their default
 * `mine` bucket on /conversations" and "what threads belong to accounts
 * that rep owns on the CRM side." Mirrors the CQ ownership audit pattern
 * (numbers first, decisions later).
 *
 * For each org and each active rep R (users.is_active != false), counts:
 *
 *   1) mine_threads_count(R)
 *      Threads where ownerUserId = R.id AND orgId = R.organizationId
 *      AND the thread is in the default "mine" bucket today, i.e.
 *      archived_at IS NULL AND waiting_state != 'snoozed'. This mirrors
 *      storage.listEmailConversationThreads() lines 9634/9649 — we
 *      reuse, not invent, the chokepoint definition.
 *
 *   2) account_owned_unowned_threads_count(R)   (CONV-G1 cohort)
 *      Threads where companies.owner_rep_id = R.id AND
 *      email_conversation_threads.linked_account_id = companies.id AND
 *      email_conversation_threads.owner_user_id IS NULL AND the same
 *      "default mine" filters apply (archived/snoozed excluded).
 *
 *   3) account_owned_misowned_threads_count(R)
 *      Threads where companies.owner_rep_id = R.id AND
 *      email_conversation_threads.linked_account_id = companies.id AND
 *      email_conversation_threads.owner_user_id IS NOT NULL AND
 *      email_conversation_threads.owner_user_id != R.id AND the same
 *      "default mine" filters apply.
 *
 * Strict zero-write contract: SELECT-only, no production code modified,
 * no schema, no flags, no behavior change.
 *
 * Usage:
 *   npx tsx tools/audit-conversations-visibility.ts
 *   npx tsx tools/audit-conversations-visibility.ts --org-slug=valuetruck
 */

import { sql } from "drizzle-orm";
import { db } from "../server/storage";
import { writeFileSync } from "node:fs";

const SAMPLES_PER_BUCKET = 8;
const REPORT_PATH = "docs/conversations-visibility-audit-2026-05-15.md";

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  thread_count: number;
}

interface RepRow {
  user_id: string;
  rep_name: string;
  mine_threads_count: number;
  account_owned_unowned_threads_count: number;
  account_owned_misowned_threads_count: number;
}

interface SampleRow {
  thread_record_id: string;
  thread_id: string | null;
  linked_account_id: string | null;
  account_name: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  rep_id: string;
  rep_name: string;
}

function parseArgs(): { orgSlug: string | null } {
  const a = process.argv.slice(2);
  let orgSlug: string | null = null;
  for (const x of a) {
    if (x.startsWith("--org-slug=")) orgSlug = x.slice("--org-slug=".length);
  }
  return { orgSlug };
}

async function listOrgs(orgSlug: string | null): Promise<OrgRow[]> {
  const slugFilter = orgSlug ? sql`AND o.slug = ${orgSlug}` : sql``;
  const r = await db.execute<OrgRow>(sql`
    SELECT
      o.id,
      o.name,
      o.slug,
      COUNT(t.id)::int AS thread_count
    FROM organizations o
    LEFT JOIN email_conversation_threads t
      ON t.org_id = o.id
      AND t.archived_at IS NULL
      AND t.waiting_state != 'snoozed'
    WHERE 1=1 ${slugFilter}
    GROUP BY o.id, o.name, o.slug
    HAVING COUNT(t.id) > 0
    ORDER BY COUNT(t.id) DESC
  `);
  return (r as any).rows ?? (r as any);
}

async function perRepCounts(orgId: string): Promise<RepRow[]> {
  const r = await db.execute<RepRow>(sql`
    WITH active_reps AS (
      SELECT u.id AS user_id, COALESCE(u.name, u.username) AS rep_name
      FROM users u
      WHERE u.organization_id = ${orgId}
        AND COALESCE(u.is_active, true) = true
    ),
    mine AS (
      SELECT t.owner_user_id AS user_id, COUNT(*)::int AS c
      FROM email_conversation_threads t
      WHERE t.org_id = ${orgId}
        AND t.owner_user_id IS NOT NULL
        AND t.archived_at IS NULL
        AND t.waiting_state != 'snoozed'
      GROUP BY t.owner_user_id
    ),
    unowned AS (
      SELECT c.owner_rep_id AS user_id, COUNT(*)::int AS c
      FROM email_conversation_threads t
      JOIN companies c ON c.id = t.linked_account_id
      WHERE t.org_id = ${orgId}
        AND c.owner_rep_id IS NOT NULL
        AND t.owner_user_id IS NULL
        AND t.archived_at IS NULL
        AND t.waiting_state != 'snoozed'
      GROUP BY c.owner_rep_id
    ),
    misowned AS (
      SELECT c.owner_rep_id AS user_id, COUNT(*)::int AS c
      FROM email_conversation_threads t
      JOIN companies c ON c.id = t.linked_account_id
      WHERE t.org_id = ${orgId}
        AND c.owner_rep_id IS NOT NULL
        AND t.owner_user_id IS NOT NULL
        AND t.owner_user_id != c.owner_rep_id
        AND t.archived_at IS NULL
        AND t.waiting_state != 'snoozed'
      GROUP BY c.owner_rep_id
    )
    SELECT
      ar.user_id,
      ar.rep_name,
      COALESCE(mine.c, 0)     AS mine_threads_count,
      COALESCE(unowned.c, 0)  AS account_owned_unowned_threads_count,
      COALESCE(misowned.c, 0) AS account_owned_misowned_threads_count
    FROM active_reps ar
    LEFT JOIN mine     ON mine.user_id     = ar.user_id
    LEFT JOIN unowned  ON unowned.user_id  = ar.user_id
    LEFT JOIN misowned ON misowned.user_id = ar.user_id
    ORDER BY
      (COALESCE(unowned.c, 0) + COALESCE(misowned.c, 0)) DESC,
      COALESCE(mine.c, 0) DESC
  `);
  return (r as any).rows ?? (r as any);
}

async function unownedSamples(orgId: string): Promise<SampleRow[]> {
  const r = await db.execute<SampleRow>(sql`
    SELECT
      t.id            AS thread_record_id,
      t.thread_id     AS thread_id,
      t.linked_account_id,
      c.name          AS account_name,
      NULL::text      AS owner_user_id,
      NULL::text      AS owner_name,
      c.owner_rep_id  AS rep_id,
      COALESCE(u.name, u.username) AS rep_name
    FROM email_conversation_threads t
    JOIN companies c ON c.id = t.linked_account_id
    JOIN users u ON u.id = c.owner_rep_id
    WHERE t.org_id = ${orgId}
      AND c.owner_rep_id IS NOT NULL
      AND t.owner_user_id IS NULL
      AND t.archived_at IS NULL
      AND t.waiting_state != 'snoozed'
    ORDER BY t.last_email_at DESC NULLS LAST
    LIMIT ${SAMPLES_PER_BUCKET}
  `);
  return (r as any).rows ?? (r as any);
}

async function misownedSamples(orgId: string): Promise<SampleRow[]> {
  const r = await db.execute<SampleRow>(sql`
    SELECT
      t.id            AS thread_record_id,
      t.thread_id     AS thread_id,
      t.linked_account_id,
      c.name          AS account_name,
      t.owner_user_id AS owner_user_id,
      COALESCE(uo.name, uo.username) AS owner_name,
      c.owner_rep_id  AS rep_id,
      COALESCE(ur.name, ur.username) AS rep_name
    FROM email_conversation_threads t
    JOIN companies c ON c.id = t.linked_account_id
    JOIN users ur ON ur.id = c.owner_rep_id
    LEFT JOIN users uo ON uo.id = t.owner_user_id
    WHERE t.org_id = ${orgId}
      AND c.owner_rep_id IS NOT NULL
      AND t.owner_user_id IS NOT NULL
      AND t.owner_user_id != c.owner_rep_id
      AND t.archived_at IS NULL
      AND t.waiting_state != 'snoozed'
    ORDER BY t.last_email_at DESC NULLS LAST
    LIMIT ${SAMPLES_PER_BUCKET}
  `);
  return (r as any).rows ?? (r as any);
}

function fmtPct(n: number, d: number): string {
  if (d === 0) return "—";
  return ((n / d) * 100).toFixed(1) + "%";
}

function repTable(rows: RepRow[]): string {
  const header = `| rep_user_id | rep_name | mine_threads_count | account_owned_unowned_threads_count | account_owned_misowned_threads_count |\n|---|---|---:|---:|---:|`;
  const body = rows.map(r =>
    `| \`${r.user_id.slice(0, 8)}…\` | ${r.rep_name ?? ""} | ${r.mine_threads_count} | ${r.account_owned_unowned_threads_count} | ${r.account_owned_misowned_threads_count} |`,
  ).join("\n");
  return `${header}\n${body}`;
}

function sampleTable(samples: SampleRow[], includeOwner: boolean): string {
  if (samples.length === 0) return "_(no rows)_";
  const head = includeOwner
    ? `| thread_id | account | account_owner_rep | thread_owner_user |\n|---|---|---|---|`
    : `| thread_id | account | account_owner_rep |\n|---|---|---|`;
  const body = samples.map(s => {
    const acct = `${s.account_name ?? "?"} (\`${(s.linked_account_id ?? "").slice(0, 8)}…\`)`;
    const repCell = `${s.rep_name ?? "?"} (\`${s.rep_id.slice(0, 8)}…\`)`;
    if (!includeOwner) {
      return `| \`${(s.thread_id ?? s.thread_record_id).slice(0, 16)}…\` | ${acct} | ${repCell} |`;
    }
    const ownerCell = s.owner_user_id
      ? `${s.owner_name ?? "?"} (\`${s.owner_user_id.slice(0, 8)}…\`)`
      : "—";
    return `| \`${(s.thread_id ?? s.thread_record_id).slice(0, 16)}…\` | ${acct} | ${repCell} | ${ownerCell} |`;
  }).join("\n");
  return `${head}\n${body}`;
}

async function main() {
  const { orgSlug } = parseArgs();
  console.log(`[CONV-1.1-A] Starting visibility audit${orgSlug ? ` (orgSlug=${orgSlug})` : ""}…`);

  const orgs = await listOrgs(orgSlug);
  console.log(`[CONV-1.1-A] Found ${orgs.length} org(s) with at least one non-archived, non-snoozed thread.`);

  const today = new Date().toISOString().slice(0, 10);
  let md = `# Conversations Visibility Audit — ${today}\n\n`;
  md += `_Subtask CONV-1.1-A. SELECT-only audit comparing thread visibility (\`email_conversation_threads.owner_user_id\`) with account ownership (\`companies.owner_rep_id\`). No production code, schema, or behavior changed._\n\n`;
  md += `**"Default mine" definition mirrored from \`server/storage.ts\` \`listEmailConversationThreads\`:** \`archived_at IS NULL AND waiting_state != 'snoozed'\`.\n\n`;
  md += `**Bucket meanings.**\n`;
  md += `- \`mine_threads_count\` — what the rep sees in their default \`mine\` bucket today (\`owner_user_id = R.id\`).\n`;
  md += `- \`account_owned_unowned_threads_count\` (**CONV-G1**) — "I own the account, but the thread is unowned." Rep does NOT see these in \`mine\` today; they live in the separate \`unowned\` bucket.\n`;
  md += `- \`account_owned_misowned_threads_count\` — "I own the account, but the thread is stamped to a different rep." Rep does NOT see these in \`mine\` today; the other rep does.\n\n`;
  md += `---\n\n`;

  // Grand totals (across all orgs)
  let gMine = 0, gUnowned = 0, gMis = 0;

  const perOrg: { org: OrgRow; reps: RepRow[]; unownedSample: SampleRow[]; misownedSample: SampleRow[] }[] = [];

  for (const org of orgs) {
    const reps = await perRepCounts(org.id);
    const unS = await unownedSamples(org.id);
    const miS = await misownedSamples(org.id);
    perOrg.push({ org, reps, unownedSample: unS, misownedSample: miS });
    for (const r of reps) {
      gMine += Number(r.mine_threads_count);
      gUnowned += Number(r.account_owned_unowned_threads_count);
      gMis += Number(r.account_owned_misowned_threads_count);
    }
  }

  md += `## Grand totals (all orgs)\n\n`;
  md += `| metric | count |\n|---|---:|\n`;
  md += `| Σ mine_threads_count (across active reps, all orgs) | **${gMine}** |\n`;
  md += `| Σ account_owned_unowned_threads_count (CONV-G1) | **${gUnowned}** |\n`;
  md += `| Σ account_owned_misowned_threads_count | **${gMis}** |\n`;
  md += `| CONV-G1 ratio (unowned-to-mine) | ${fmtPct(gUnowned, gMine)} |\n`;
  md += `| Misowned ratio (misowned-to-mine) | ${fmtPct(gMis, gMine)} |\n\n`;

  for (const { org, reps, unownedSample, misownedSample } of perOrg) {
    const orgMine = reps.reduce((s, r) => s + Number(r.mine_threads_count), 0);
    const orgUn = reps.reduce((s, r) => s + Number(r.account_owned_unowned_threads_count), 0);
    const orgMi = reps.reduce((s, r) => s + Number(r.account_owned_misowned_threads_count), 0);

    md += `---\n\n## Org: ${org.name} (\`${org.slug}\`)\n\n`;
    md += `Visible thread universe (org-wide, archived/snoozed excluded): **${org.thread_count}**\n\n`;
    md += `**Org totals:** mine=**${orgMine}** · unowned-but-account-owned=**${orgUn}** (CONV-G1 ${fmtPct(orgUn, orgMine)}) · misowned=**${orgMi}** (${fmtPct(orgMi, orgMine)})\n\n`;
    md += `### Per-rep table\n\n`;
    md += `${repTable(reps)}\n\n`;
    md += `### Sample — account_owned_unowned (CONV-G1)\n\n`;
    md += `${sampleTable(unownedSample, false)}\n\n`;
    md += `### Sample — account_owned_misowned\n\n`;
    md += `${sampleTable(misownedSample, true)}\n\n`;
  }

  md += `---\n\n## Findings\n\n`;
  md += `- **CONV-G1 size (unowned-but-account-owned).** Across all orgs, ${gUnowned} threads belong to accounts whose \`owner_rep_id\` is set, but the thread itself has \`owner_user_id IS NULL\`. As a fraction of the rep's "mine" working set this is ${fmtPct(gUnowned, gMine)}. These threads are not reachable from the rep's default queue; they live in the separate \`unowned\` bucket only.\n`;
  md += `- **Misowned cohort.** ${gMis} threads belong to accounts whose \`owner_rep_id\` is set but were stamped (initially or later) to a different \`owner_user_id\`. Some of these are legitimate (a colleague handled the thread on the rep's behalf) and some are likely stale assignments from before the account changed hands — distinguishing the two requires a follow-up audit (e.g., comparing \`email_conversation_threads.created_at\` to \`companies.owner_rep_id\`'s last change time).\n`;
  md += `- **Implications for CONV-1.1-B.** If the CONV-G1 ratio is small, pinning the current strict \`owner_user_id\`-based visibility predicate via guardrails is safe and the gap can be closed at the UI layer (e.g., a \`mine_or_my_accounts\` synthetic bucket). If the ratio is large, a policy decision is needed before pinning — widening the rule has UX trade-offs (a rep would suddenly see threads they didn't choose to own).\n\n`;
  md += `---\n\n## Methodology / contract compliance\n\n`;
  md += `- All queries are SELECT-only (\`db.execute(sql\\\`SELECT …\\\`)\`). No \`INSERT\`/\`UPDATE\`/\`DELETE\`.\n`;
  md += `- "Default mine" filter mirrors \`storage.listEmailConversationThreads\` — \`archived_at IS NULL AND waiting_state != 'snoozed'\`. We did not invent a new filter.\n`;
  md += `- Active reps are \`COALESCE(users.is_active, true) = true\` and scoped to the org under audit.\n`;
  md += `- The CONV-G1 counter only fires when \`companies.owner_rep_id IS NOT NULL\` — accounts with no canonical owner are excluded from both the numerator and the denominator of the gap ratio.\n`;
  md += `- Soft-deleted accounts (\`companies.archived_at\`, \`companies.deleted_at\` if present) are NOT excluded — the audit reflects the full ownership graph as the data model carries it. A future audit could re-run with that exclusion to see whether legacy archived accounts inflate the count.\n`;
  md += `- No \`monitored_mailboxes\` semantics consulted — this audit is strictly about the rep ⇄ thread ⇄ account ownership triangle.\n`;

  writeFileSync(REPORT_PATH, md, "utf8");
  console.log(`[CONV-1.1-A] Wrote ${REPORT_PATH}`);
  console.log(`[CONV-1.1-A] Grand totals: mine=${gMine} unowned=${gUnowned} misowned=${gMis}`);
  process.exit(0);
}

main().catch(err => {
  console.error("[CONV-1.1-A] Fatal:", err);
  process.exit(1);
});
