/**
 * Task #1126 — Phase 0 read-only User Roster Health classifier.
 *
 * Loads every user in an organization and bins them into six heuristic
 * buckets so admins can see the actual shape of the roster before any
 * schema flags, soft-delete, or default-list filtering is added.
 *
 * Strict zero-write contract: this module performs SELECT-only queries.
 * No INSERT/UPDATE/DELETE, no calls into write-capable storage methods.
 *
 * Result is cached in-process for 60s per org so the panel can re-render
 * cheaply without re-scanning the whole roster on every poll.
 */

import { sql, and, eq, inArray } from "drizzle-orm";
import { db } from "../storage";
import {
  users,
  companies,
  touchpoints,
  contextNotes,
  tasks,
  crmOpportunities,
  organizations,
  freightDailyUploadFact,
} from "@shared/schema";

export type RosterBucket =
  | "likely_junk"
  | "likely_demo_fixture"
  | "likely_service_shared_inbox"
  | "real_active"
  | "real_inactive"
  | "uncertain";

export const ROSTER_BUCKETS: RosterBucket[] = [
  "likely_junk",
  "likely_demo_fixture",
  "likely_service_shared_inbox",
  "real_active",
  "real_inactive",
  "uncertain",
];

export const ROSTER_BUCKET_LABELS: Record<RosterBucket, string> = {
  likely_junk: "Likely junk",
  likely_demo_fixture: "Likely demo / fixture",
  likely_service_shared_inbox: "Likely service / shared-inbox",
  real_active: "Real and active",
  real_inactive: "Real but inactive",
  uncertain: "Uncertain",
};

export interface UserActivitySummary {
  notesAuthored: number;
  touchpoints: number;
  ownedCompanies: number;
  ownedOpportunities: number;
  assignedTasks: number;
  freightRows: number;
}

export interface ClassifiedUser {
  id: string;
  name: string;
  username: string;
  role: string;
  organizationId: string;
  managerId: string | null;
  financialRepId: string | null;
  lastLoginAt: string | null;
  createdAt: string | null;
  bucket: RosterBucket;
  reason: string;
  /**
   * Catalogue of every heuristic that fired for this user. Independent of
   * `bucket` — a `real_active` user can still carry e.g. `no-fin-rep-id`.
   * UI renders these as small badges so reviewers can see WHY a row landed
   * where it did.
   */
  signals: string[];
  /**
   * 0..100, higher = more clearly cleanup-worthy. Used to sort cleanup
   * buckets so the most obviously bad rows surface first instead of the
   * most-active rows. See `computeReviewPriority`.
   */
  reviewPriority: number;
  activity: UserActivitySummary;
  totalActivity: number;
}

export interface RosterHealthSnapshot {
  organizationId: string;
  generatedAt: string;
  totalUsers: number;
  bucketCounts: Record<RosterBucket, number>;
  users: ClassifiedUser[];
}

// ── Classification rules ─────────────────────────────────────────────────────

// Junk-ish login local-parts / patterns. Matched as substrings on the
// lowercased username (login email).
const JUNK_PATTERNS: RegExp[] = [
  /(^|[._+\-])test([._+\-@]|$)/,
  /\+test@/,
  /(^|[._+\-])demo([._+\-@]|$)/,
  /(^|[._+\-])example([._+\-@]|$)/,
  /^asdf/,
  /^foo@/,
  /^bar@/,
  /^qwerty/,
  /^abc(123)?@/,
  /^xxx@/,
];

const JUNK_DOMAIN_SUFFIXES: string[] = [
  "@example.com",
  "@example.org",
  "@example.net",
  "@test.com",
  "@test.local",
  "@local.test",
  ".invalid",
  ".test",
  ".example",
  ".localhost",
  "@mailinator.com",
  "@yopmail.com",
];

// Service / shared-inbox local-parts. Matched at the start of the local part.
const SERVICE_LOCAL_PARTS: string[] = [
  "rfq@",
  "rfqs@",
  "tenders@",
  "tender@",
  "bids@",
  "bid@",
  "quotes@",
  "quote@",
  "noreply@",
  "no-reply@",
  "donotreply@",
  "do-not-reply@",
  "info@",
  "support@",
  "sales@",
  "ops@",
  "operations@",
  "dispatch@",
  "logistics@",
  "shipping@",
  "shipping-quotes@",
  "inbox@",
  "inbox+",
  "team@",
  "hello@",
  "contact@",
  "billing@",
  "ar@",
  "ap@",
];

const SERVICE_PATTERNS: RegExp[] = [
  /\+team@/,
  /\+inbox@/,
  /\+rfq@/,
  /\+tenders?@/,
  /^inbox\+/,
  /^rfq\+/,
];

// Seed-script username patterns (user.name / username conventions used by
// scripts/seed-*.ts). Conservative — anything ambiguous falls through to
// "uncertain" rather than a confident demo classification.
const SEED_NAME_PATTERNS: RegExp[] = [
  /^seed[._-]/i,
  /^demo[._-]/i,
  /^fixture[._-]/i,
  /^wq\.test\./i, // lane-work-queue test users
  /^test[._-]?user/i,
];

const SEED_USERNAME_PATTERNS: RegExp[] = [
  /^seed[._+\-]/i,
  /^demo[._+\-]/i,
  /^fixture[._+\-]/i,
  /^wq\.test\./i,
  /^director\.\d+@/i,
  /^lm\.\d+@/i,
  /^am\.\d+@/i,
];

// Org slug / name patterns that mark an organization as a demo / fixture
// org. Used to bulk-classify all members of that org as demo without
// requiring per-user pattern matches.
const DEMO_ORG_SLUG_PATTERNS: RegExp[] = [
  /^demo$/i,
  /^demo[-_.]/i,
  /^fixture/i,
  /^test[-_.]/i,
  /^seed/i,
];

const ACTIVE_LOGIN_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(value));
}

function endsWithAny(value: string, suffixes: string[]): boolean {
  return suffixes.some((s) => value.endsWith(s));
}

function startsWithAny(value: string, prefixes: string[]): boolean {
  return prefixes.some((p) => value.startsWith(p));
}

function isJunkUsername(username: string): boolean {
  const lower = username.toLowerCase();
  if (endsWithAny(lower, JUNK_DOMAIN_SUFFIXES)) return true;
  if (matchesAny(lower, JUNK_PATTERNS)) return true;
  // Bare local-parts with no @ — almost always junk.
  if (!lower.includes("@")) {
    if (/^(test|demo|asdf|foo|bar|qwerty|abc|xxx)\d*$/.test(lower)) return true;
  }
  return false;
}

function isServiceUsername(username: string): boolean {
  const lower = username.toLowerCase();
  if (startsWithAny(lower, SERVICE_LOCAL_PARTS)) return true;
  if (matchesAny(lower, SERVICE_PATTERNS)) return true;
  return false;
}

function isSeedUser(name: string, username: string): boolean {
  if (matchesAny(name, SEED_NAME_PATTERNS)) return true;
  if (matchesAny(username, SEED_USERNAME_PATTERNS)) return true;
  return false;
}

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  expiresAt: number;
  snapshot: RosterHealthSnapshot;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

export function invalidateRosterHealthCache(organizationId?: string): void {
  if (organizationId) cache.delete(organizationId);
  else cache.clear();
}

// ── Main classifier ──────────────────────────────────────────────────────────

export async function getRosterHealthSnapshot(
  organizationId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<RosterHealthSnapshot> {
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = cache.get(organizationId);
    if (cached && cached.expiresAt > now) return cached.snapshot;
  }

  // Org row — used to detect demo/fixture orgs.
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, organizationId));

  const orgIsDemo = !!org && (
    matchesAny(org.slug ?? "", DEMO_ORG_SLUG_PATTERNS) ||
    matchesAny(org.name ?? "", DEMO_ORG_SLUG_PATTERNS)
  );

  // All users for this org. SELECT only.
  const orgUsers = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      role: users.role,
      organizationId: users.organizationId,
      managerId: users.managerId,
      financialRepId: users.financialRepId,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.organizationId, organizationId));

  const userIds = orgUsers.map((u) => u.id);

  // Activity counts — one batched query per source table.
  const empty = new Map<string, number>();
  const [
    notesByAuthor,
    touchpointsByLogger,
    companiesByAssigned,
    oppsByCreator,
    tasksByAssignee,
    freightByOwner,
  ] = userIds.length === 0
    ? [empty, empty, empty, empty, empty, empty]
    : await Promise.all([
        countByKey(
          db
            .select({ key: contextNotes.authorId, n: sql<number>`count(*)::int` })
            .from(contextNotes)
            .where(and(eq(contextNotes.orgId, organizationId), inArray(contextNotes.authorId, userIds)))
            .groupBy(contextNotes.authorId),
        ),
        countByKey(
          db
            .select({ key: touchpoints.loggedById, n: sql<number>`count(*)::int` })
            .from(touchpoints)
            .where(inArray(touchpoints.loggedById, userIds))
            .groupBy(touchpoints.loggedById),
        ),
        countByKey(
          db
            .select({ key: companies.assignedTo, n: sql<number>`count(*)::int` })
            .from(companies)
            .where(and(eq(companies.organizationId, organizationId), inArray(companies.assignedTo, userIds)))
            .groupBy(companies.assignedTo),
        ),
        countByKey(
          db
            .select({ key: crmOpportunities.createdById, n: sql<number>`count(*)::int` })
            .from(crmOpportunities)
            .where(and(eq(crmOpportunities.organizationId, organizationId), inArray(crmOpportunities.createdById, userIds)))
            .groupBy(crmOpportunities.createdById),
        ),
        countByKey(
          db
            .select({ key: tasks.assignedTo, n: sql<number>`count(*)::int` })
            .from(tasks)
            .where(inArray(tasks.assignedTo, userIds))
            .groupBy(tasks.assignedTo),
        ),
        countFreightAttributableByOwner(organizationId, userIds),
      ]);

  const classified: ClassifiedUser[] = orgUsers.map((u) => {
    const activity: UserActivitySummary = {
      notesAuthored: notesByAuthor.get(u.id) ?? 0,
      touchpoints: touchpointsByLogger.get(u.id) ?? 0,
      ownedCompanies: companiesByAssigned.get(u.id) ?? 0,
      ownedOpportunities: oppsByCreator.get(u.id) ?? 0,
      assignedTasks: tasksByAssignee.get(u.id) ?? 0,
      freightRows: freightByOwner.get(u.id) ?? 0,
    };
    const totalActivity =
      activity.notesAuthored +
      activity.touchpoints +
      activity.ownedCompanies +
      activity.ownedOpportunities +
      activity.assignedTasks +
      activity.freightRows;

    const signals = collectSignals(u, activity, totalActivity, orgIsDemo);
    const { bucket, reason } = classifyOne(u, activity, totalActivity, orgIsDemo);
    const reviewPriority = computeReviewPriority(signals, totalActivity, u.lastLoginAt ?? null);

    return {
      id: u.id,
      name: u.name,
      username: u.username,
      role: u.role,
      organizationId: u.organizationId,
      managerId: u.managerId ?? null,
      financialRepId: u.financialRepId ?? null,
      lastLoginAt: u.lastLoginAt ?? null,
      createdAt: u.createdAt ?? null,
      bucket,
      reason,
      signals,
      reviewPriority,
      activity,
      totalActivity,
    };
  });

  const bucketCounts = ROSTER_BUCKETS.reduce<Record<RosterBucket, number>>((acc, b) => {
    acc[b] = 0;
    return acc;
  }, {} as Record<RosterBucket, number>);
  for (const c of classified) bucketCounts[c.bucket] += 1;

  const snapshot: RosterHealthSnapshot = {
    organizationId,
    generatedAt: new Date().toISOString(),
    totalUsers: classified.length,
    bucketCounts,
    users: classified,
  };

  cache.set(organizationId, { expiresAt: now + CACHE_TTL_MS, snapshot });
  return snapshot;
}

/**
 * Catalogue of every heuristic that fires for a user. This is independent
 * of bucket assignment — we still want to surface e.g. `no-fin-rep-id` on a
 * `real_active` user so reviewers see the data-quality footnote. Tag names
 * are stable identifiers (kebab-case, colon-separated) safe to use in
 * `data-testid` and CSV columns.
 */
function collectSignals(
  u: { name: string; username: string; managerId?: string | null; financialRepId?: string | null; lastLoginAt?: string | null; createdAt?: string | null },
  activity: UserActivitySummary,
  totalActivity: number,
  orgIsDemo: boolean,
): string[] {
  const out: string[] = [];
  const username = (u.username ?? "").trim();
  const name = (u.name ?? "").trim();
  const lower = username.toLowerCase();

  // Junk / test-pattern signals
  if (endsWithAny(lower, JUNK_DOMAIN_SUFFIXES)) {
    if (lower.endsWith("@mailinator.com")) out.push("username:mailinator");
    else out.push("username:junk-domain");
  }
  if (matchesAny(lower, JUNK_PATTERNS)) {
    if (/\+test@/.test(lower)) out.push("username:plus-test");
    else out.push("username:test-pattern");
  }
  if (!lower.includes("@") && /^(test|demo|asdf|foo|bar|qwerty|abc|xxx)\d*$/.test(lower)) {
    out.push("username:bare-junk-localpart");
  }

  // Service / shared-inbox local-part
  for (const prefix of SERVICE_LOCAL_PARTS) {
    if (lower.startsWith(prefix)) {
      const tag = prefix.replace(/[@+]/g, "");
      if (tag === "noreply" || tag === "no-reply" || tag === "donotreply" || tag === "do-not-reply") {
        out.push("local-part:noreply");
      } else {
        out.push(`local-part:${tag}`);
      }
      break;
    }
  }
  if (matchesAny(lower, SERVICE_PATTERNS)) out.push("local-part:shared-inbox");

  // Seed / fixture
  if (matchesAny(name, SEED_NAME_PATTERNS) || matchesAny(username, SEED_USERNAME_PATTERNS)) {
    if (/^wq\.test\./i.test(name) || /^wq\.test\./i.test(username)) out.push("seed:wq.test");
    else if (/^am\.\d+@/i.test(username)) out.push("seed:am.NNN");
    else if (/^director\.\d+@/i.test(username)) out.push("seed:director.NNN");
    else if (/^lm\.\d+@/i.test(username)) out.push("seed:lm.NNN");
    else out.push("seed:fixture-pattern");
  }

  // Org-level demo / fixture
  if (orgIsDemo) out.push("org:demo-or-fixture");

  // Activity / login signals
  if (totalActivity === 0) out.push("zero-activity");
  const lastLoginMs = parseTimestampMs(u.lastLoginAt ?? null);
  if (lastLoginMs === null) {
    out.push("last-login:never");
  } else {
    const ageMs = Date.now() - lastLoginMs;
    if (ageMs > 180 * 24 * 60 * 60 * 1000) out.push("last-login:>180d");
  }
  const createdMs = parseTimestampMs(u.createdAt ?? null);
  if (createdMs !== null) {
    const ageMs = Date.now() - createdMs;
    if (ageMs < 7 * 24 * 60 * 60 * 1000 && totalActivity === 0) {
      out.push("created:<7d-no-activity");
    }
  }

  // Org-chart / financial-mapping data-quality
  if (!u.managerId) out.push("no-manager");
  if (!u.financialRepId || u.financialRepId.trim().length === 0) out.push("no-fin-rep-id");

  return out;
}

/**
 * 0..100, higher = more clearly cleanup-worthy.
 *   +30 per cleanup-positive signal (junk / service / seed / demo-org / zero-activity / never-logged-in / very-old-login / created-but-idle)
 *   −40 if any non-zero downstream activity
 *   −20 if a recent login (≤90d, the same window the classifier already uses)
 * Clamped to [0, 100]. Pure data-quality signals (`no-manager`, `no-fin-rep-id`) carry no weight here — they show as badges only.
 */
const CLEANUP_POSITIVE_SIGNALS = new Set<string>([
  "username:mailinator",
  "username:junk-domain",
  "username:test-pattern",
  "username:plus-test",
  "username:bare-junk-localpart",
  "local-part:noreply",
  "local-part:shared-inbox",
  "seed:wq.test",
  "seed:am.NNN",
  "seed:director.NNN",
  "seed:lm.NNN",
  "seed:fixture-pattern",
  "org:demo-or-fixture",
  "zero-activity",
  "last-login:never",
  "last-login:>180d",
  "created:<7d-no-activity",
]);

function computeReviewPriority(signals: string[], totalActivity: number, lastLoginAt: string | null): number {
  let score = 0;
  for (const s of signals) {
    if (CLEANUP_POSITIVE_SIGNALS.has(s)) score += 30;
  }
  if (totalActivity > 0) score -= 40;
  const lastLoginMs = parseTimestampMs(lastLoginAt);
  if (lastLoginMs !== null && Date.now() - lastLoginMs < ACTIVE_LOGIN_WINDOW_MS) {
    score -= 20;
  }
  if (score < 0) return 0;
  if (score > 100) return 100;
  return score;
}

function classifyOne(
  u: { name: string; username: string; lastLoginAt?: string | null },
  activity: UserActivitySummary,
  totalActivity: number,
  orgIsDemo: boolean,
): { bucket: RosterBucket; reason: string } {
  const username = (u.username ?? "").trim();
  const name = (u.name ?? "").trim();

  // Order matters: junk first (cheapest, most-confident), then service,
  // then seed/demo, then activity-based real classifications. "Uncertain"
  // is the safety valve.

  if (isJunkUsername(username) && totalActivity === 0) {
    return { bucket: "likely_junk", reason: "junk_email_pattern" };
  }

  if (isServiceUsername(username)) {
    return { bucket: "likely_service_shared_inbox", reason: "service_inbox_pattern" };
  }

  if (orgIsDemo) {
    return { bucket: "likely_demo_fixture", reason: "demo_org_slug" };
  }
  if (isSeedUser(name, username)) {
    return { bucket: "likely_demo_fixture", reason: "seed_script_username" };
  }

  const lastLoginMs = parseTimestampMs(u.lastLoginAt ?? null);
  const recentLogin = lastLoginMs !== null && Date.now() - lastLoginMs < ACTIVE_LOGIN_WINDOW_MS;

  if (recentLogin && totalActivity > 0) {
    return { bucket: "real_active", reason: "recent_login_and_activity" };
  }
  if (!recentLogin && totalActivity > 0) {
    return { bucket: "real_inactive", reason: "historical_activity_only" };
  }

  // Caught-all junk: pattern match but no activity already returned above.
  // Pattern match WITH activity treated as uncertain (real human using a
  // weird-looking address).
  if (isJunkUsername(username)) {
    return { bucket: "uncertain", reason: "junk_pattern_but_has_activity" };
  }

  return { bucket: "uncertain", reason: "no_login_no_activity_no_pattern" };
}

function parseTimestampMs(v: string | null): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

async function countByKey(
  query: Promise<Array<{ key: string | null; n: number }>>,
): Promise<Map<string, number>> {
  const rows = await query;
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.key) out.set(r.key, Number(r.n) || 0);
  }
  return out;
}

async function countFreightAttributableByOwner(
  organizationId: string,
  userIds: string[],
): Promise<Map<string, number>> {
  // Attribute freight rows to a user via the company they own:
  //   freight_daily_upload_fact.customer  ==  companies.name (or financial_alias)
  //   AND companies.assigned_to = user
  // This mirrors the mapping the dashboard/goals routes use when they roll
  // freight margin up to a rep, but counts rows (not dollars) to keep the
  // snapshot a cheap activity proxy. Read-only, org-scoped on both sides.
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({
      key: companies.assignedTo,
      n: sql<number>`count(*)`.as("n"),
    })
    .from(freightDailyUploadFact)
    .innerJoin(
      companies,
      and(
        eq(companies.organizationId, organizationId),
        sql`(
          lower(${companies.name}) = lower(${freightDailyUploadFact.customer})
          OR (
            ${companies.financialAlias} IS NOT NULL
            AND lower(${companies.financialAlias}) = lower(${freightDailyUploadFact.customer})
          )
        )`,
      ),
    )
    .where(
      and(
        eq(freightDailyUploadFact.orgId, organizationId),
        inArray(companies.assignedTo, userIds),
      ),
    )
    .groupBy(companies.assignedTo);

  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.key) out.set(r.key, Number(r.n) || 0);
  }
  return out;
}
