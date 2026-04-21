/**
 * ValueIQ "Today" thread seeder.
 *
 * Idempotently creates one pinned "Today — YYYY-MM-DD" thread per active rep
 * and seeds it with the four-section morning briefing produced by
 * server/agent/todaySeed.ts. Honors the org-level
 * `agent_org_settings.valueiq_today_seed_enabled` kill switch.
 *
 * Default cadence: 6:00 AM America/Chicago. Overridable via
 * VALUEIQ_TODAY_CRON env var (cron expression).
 */
import cron from "node-cron";
import { and, eq, desc, sql } from "drizzle-orm";
import { db, storage } from "./storage";
import {
  organizations as organizationsTable,
  threads as threadsTable,
  threadMessages as threadMessagesTable,
  agentOrgSettings,
  type User,
} from "@shared/schema";
import { ensureDefaultAgent } from "./agent/persona";
import { buildTodaySeed } from "./agent/todaySeed";

const SEED_KIND = "today_seed";
const REP_ROLES = new Set([
  "account_manager",
  "national_account_manager",
  "sales",
  "sales_director",
  "director",
  "carrier_rep",
]);

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [valueiq-today] ${msg}`);
}

/**
 * Resolve the org's configured timezone for date-key generation. Defaults
 * to America/Chicago when no settings row exists.
 */
export async function getOrgTodayTimezone(orgId: string): Promise<string> {
  const [settings] = await db.select().from(agentOrgSettings)
    .where(eq(agentOrgSettings.organizationId, orgId)).limit(1);
  return settings?.valueiqTodayTimezone || "America/Chicago";
}

export async function seedTodayForUser(user: User, opts: { overwrite?: boolean; timeZone?: string } = {}): Promise<{ threadId: string; created: boolean; skipped?: string; title: string; date: string }> {
  const tz = opts.timeZone || await getOrgTodayTimezone(user.organizationId);
  const seed = await buildTodaySeed(user, new Date(), tz);
  // Look up existing today thread (matched by user + seedKind + title for the
  // current local date — title carries the date so a new day = new thread).
  const [existing] = await db
    .select()
    .from(threadsTable)
    .where(and(
      eq(threadsTable.userId, user.id),
      eq(threadsTable.seedKind, SEED_KIND),
      eq(threadsTable.title, seed.title),
    ))
    .orderBy(desc(threadsTable.createdAt))
    .limit(1);

  if (existing && !opts.overwrite) {
    return { threadId: existing.id, created: false, skipped: "exists", title: seed.title, date: seed.date };
  }

  const defaultAgentId = await ensureDefaultAgent(user.organizationId);

  let threadId: string;
  if (existing) {
    threadId = existing.id;
  } else {
    // Race-safe insert: if another concurrent caller (scheduler vs. on-demand
    // GET) created the row first, the partial unique index on
    // (user_id, seed_kind, title) will trigger DO NOTHING — then we re-select
    // the existing row and proceed. This preserves idempotency at runtime in
    // addition to the schema-level guarantee.
    const inserted = await db.insert(threadsTable).values({
      organizationId: user.organizationId,
      userId: user.id,
      title: seed.title,
      defaultAgentId,
      surface: "valueiq",
      seedKind: SEED_KIND,
      pinned: true,
    }).onConflictDoNothing().returning();
    if (inserted.length > 0) {
      threadId = inserted[0].id;
    } else {
      const [raced] = await db.select().from(threadsTable).where(and(
        eq(threadsTable.userId, user.id),
        eq(threadsTable.seedKind, SEED_KIND),
        eq(threadsTable.title, seed.title),
      )).limit(1);
      if (!raced) throw new Error("Today thread race unresolved");
      threadId = raced.id;
    }
  }

  // Find the existing seed message (if any) for this thread. We match by
  // metadata->>'seedKind' so a refresh updates the briefing in place and
  // never touches user-authored chat history in the same thread.
  const [seedMsg] = await db
    .select()
    .from(threadMessagesTable)
    .where(and(
      eq(threadMessagesTable.threadId, threadId),
      sql`${threadMessagesTable.metadata}->>'seedKind' = ${SEED_KIND}`,
    ))
    .orderBy(desc(threadMessagesTable.createdAt))
    .limit(1);

  if (seedMsg) {
    if (!opts.overwrite && existing) {
      return { threadId, created: false, skipped: "exists", title: seed.title, date: seed.date };
    }
    await db.update(threadMessagesTable)
      .set({
        content: seed.markdown,
        metadata: { seedKind: SEED_KIND, seedDate: seed.date, refreshedAt: new Date().toISOString() },
      })
      .where(eq(threadMessagesTable.id, seedMsg.id));
  } else {
    await db.insert(threadMessagesTable).values({
      threadId,
      role: "assistant",
      agentId: defaultAgentId,
      agentName: "DNA",
      content: seed.markdown,
      metadata: { seedKind: SEED_KIND, seedDate: seed.date },
    });
  }

  await db.update(threadsTable)
    .set({ lastMessageAt: new Date(), updatedAt: new Date(), pinned: true })
    .where(eq(threadsTable.id, threadId));

  return { threadId, created: !existing, title: seed.title, date: seed.date };
}

async function seedTodayForOrg(orgId: string): Promise<{ created: number; skipped: number }> {
  let created = 0, skipped = 0;
  const [settings] = await db.select().from(agentOrgSettings)
    .where(eq(agentOrgSettings.organizationId, orgId)).limit(1);
  if (settings && settings.valueiqTodaySeedEnabled === false) return { created: 0, skipped: 0 };
  const users = await storage.getUsers(orgId);
  const reps = users.filter((u: User) => REP_ROLES.has(u.role));
  for (const rep of reps) {
    try {
      const r = await seedTodayForUser(rep);
      if (r.created) created++; else skipped++;
    } catch (err) {
      log(`Seed failed for ${rep.username}: ${err}`);
    }
  }
  return { created, skipped };
}

/**
 * Initialize per-org schedules so each organization runs the seeder at its
 * own configured local 6am (defaults to America/Chicago when unset).
 *
 * Cron expression itself is overridable via VALUEIQ_TODAY_CRON for ops use.
 */
export async function initValueIQTodayScheduler(): Promise<void> {
  const cronExpr = process.env.VALUEIQ_TODAY_CRON || "0 6 * * *";
  let scheduled = 0;
  try {
    const orgs = await db.select().from(organizationsTable);
    for (const org of orgs) {
      const [settings] = await db.select().from(agentOrgSettings)
        .where(eq(agentOrgSettings.organizationId, org.id)).limit(1);
      const tz = settings?.valueiqTodayTimezone || "America/Chicago";
      try {
        cron.schedule(cronExpr, () => {
          seedTodayForOrg(org.id).then(({ created, skipped }) => {
            log(`org=${org.slug} created=${created} skipped=${skipped}`);
          }).catch((err) => log(`org=${org.slug} error: ${err}`));
        }, { timezone: tz });
        scheduled++;
      } catch (err) {
        log(`Failed to schedule org=${org.slug} tz=${tz}: ${err}`);
      }
    }
    log(`Today scheduler initialized — ${scheduled} org schedule(s), cron=${cronExpr}.`);
  } catch (err) {
    log(`Scheduler init error: ${err}`);
  }
}
