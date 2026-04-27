/**
 * Task #700 — AI Engagement overview aggregate-math test
 *
 * Seeds a controlled set of `ai_engagement_events` rows for a throwaway
 * organization and then re-runs the same aggregation SQL the
 * `/api/ai-engagement/overview` endpoint uses to verify per-surface
 * aggregate math (impressions, accepts, dismisses, accept-rate,
 * dismiss-rate, ctr) is computed correctly. This protects the console
 * from silent regressions in the aggregation pipeline without dragging
 * in the Express/Clerk auth stack.
 *
 * Run: npx tsx tests/ai-engagement-overview-aggregates.test.ts
 */

import { db } from "../server/storage";
import {
  organizations,
  users,
  aiEngagementEvents,
} from "../shared/schema";
import { and, eq, gte, sql } from "drizzle-orm";

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ""}`);
    failed++;
  }
}

function approxEq(a: number, b: number, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  AI Engagement — overview aggregate math (Task #700)");
  console.log("══════════════════════════════════════════════════════════════");

  const orgId = `aie-org-${Date.now()}`;
  const userId = `aie-user-${Date.now()}`;

  await db.insert(organizations).values({
    id: orgId,
    name: "AIE Test Org",
    slug: orgId,
  });
  await db.insert(users).values({
    id: userId,
    organizationId: orgId,
    username: `aie-${Date.now()}`,
    email: `aie-${Date.now()}@test.local`,
    name: "AIE Admin",
    password: "x",
    role: "admin",
  });

  // surfaceA (nba_card): 10 impressions, 3 accepts, 2 dismisses
  // surfaceB (valueiq):   5 impressions, 1 accept,  4 dismisses
  const rows: Array<{
    organizationId: string;
    userId: string;
    surface: string;
    eventType: string;
    feature: string | null;
  }> = [];
  for (let i = 0; i < 10; i++) rows.push({ organizationId: orgId, userId, surface: "nba_card", eventType: "impression", feature: "follow_up" });
  for (let i = 0; i < 3; i++)  rows.push({ organizationId: orgId, userId, surface: "nba_card", eventType: "accept",     feature: "follow_up" });
  for (let i = 0; i < 2; i++)  rows.push({ organizationId: orgId, userId, surface: "nba_card", eventType: "dismiss",    feature: "follow_up" });
  for (let i = 0; i < 5; i++)  rows.push({ organizationId: orgId, userId, surface: "valueiq",  eventType: "impression", feature: "today" });
  rows.push({ organizationId: orgId, userId, surface: "valueiq", eventType: "accept", feature: "today" });
  for (let i = 0; i < 4; i++)  rows.push({ organizationId: orgId, userId, surface: "valueiq",  eventType: "dismiss",    feature: "today" });
  await db.insert(aiEngagementEvents).values(rows as any);

  try {
    const since = new Date(Date.now() - 30 * 86400_000);
    const baseFilter = and(
      eq(aiEngagementEvents.organizationId, orgId),
      gte(aiEngagementEvents.createdAt, since),
    );

    // ── Same group-by SQL the overview endpoint runs ────────────────────
    const surfaceRows = await db
      .select({
        surface: aiEngagementEvents.surface,
        eventType: aiEngagementEvents.eventType,
        n: sql<number>`count(*)::int`,
      })
      .from(aiEngagementEvents)
      .where(baseFilter)
      .groupBy(aiEngagementEvents.surface, aiEngagementEvents.eventType);

    const bySurface = new Map<
      string,
      { surface: string; impressions: number; accepts: number; dismisses: number }
    >();
    const ensure = (s: string) => {
      let b = bySurface.get(s);
      if (!b) {
        b = { surface: s, impressions: 0, accepts: 0, dismisses: 0 };
        bySurface.set(s, b);
      }
      return b;
    };
    for (const r of surfaceRows) {
      const b = ensure(r.surface);
      if (r.eventType === "impression") b.impressions += r.n;
      else if (r.eventType === "accept" || r.eventType === "apply" || r.eventType === "thumbs_up") b.accepts += r.n;
      else if (r.eventType === "dismiss" || r.eventType === "thumbs_down") b.dismisses += r.n;
    }
    const surfaces = [...bySurface.values()].map((b) => ({
      ...b,
      acceptRate:  b.impressions > 0 ? b.accepts   / b.impressions : 0,
      dismissRate: b.impressions > 0 ? b.dismisses / b.impressions : 0,
      ctr:         b.impressions > 0 ? (b.accepts + b.dismisses) / b.impressions : 0,
    }));

    const a = surfaces.find((s) => s.surface === "nba_card");
    const b = surfaces.find((s) => s.surface === "valueiq");

    assert("nba_card row exists", !!a);
    assert("valueiq row exists", !!b);

    if (a) {
      assert("nba_card.impressions = 10", a.impressions === 10, `got ${a.impressions}`);
      assert("nba_card.accepts = 3",      a.accepts === 3,      `got ${a.accepts}`);
      assert("nba_card.dismisses = 2",    a.dismisses === 2,    `got ${a.dismisses}`);
      assert("nba_card.acceptRate = 0.3", approxEq(a.acceptRate, 0.3), `got ${a.acceptRate}`);
      assert("nba_card.dismissRate = 0.2", approxEq(a.dismissRate, 0.2), `got ${a.dismissRate}`);
      assert("nba_card.ctr = 0.5", approxEq(a.ctr, 0.5), `got ${a.ctr}`);
    }
    if (b) {
      assert("valueiq.impressions = 5",    b.impressions === 5,           `got ${b.impressions}`);
      assert("valueiq.accepts = 1",        b.accepts === 1,               `got ${b.accepts}`);
      assert("valueiq.dismisses = 4",      b.dismisses === 4,             `got ${b.dismisses}`);
      assert("valueiq.acceptRate = 0.2",   approxEq(b.acceptRate, 0.2),   `got ${b.acceptRate}`);
      assert("valueiq.dismissRate = 0.8",  approxEq(b.dismissRate, 0.8),  `got ${b.dismissRate}`);
    }

    // Surface filter narrows the same query down to a single row
    const filteredFilter = and(
      eq(aiEngagementEvents.organizationId, orgId),
      gte(aiEngagementEvents.createdAt, since),
      eq(aiEngagementEvents.surface, "nba_card"),
    );
    const filtered = await db
      .select({ surface: aiEngagementEvents.surface, n: sql<number>`count(*)::int` })
      .from(aiEngagementEvents)
      .where(filteredFilter)
      .groupBy(aiEngagementEvents.surface);
    assert(
      "surface=nba_card filter returns exactly one bucket",
      filtered.length === 1 && filtered[0].surface === "nba_card",
      `got ${JSON.stringify(filtered)}`,
    );
    assert(
      "filtered total events = 15 (10+3+2)",
      (filtered[0]?.n ?? 0) === 15,
      `got ${filtered[0]?.n}`,
    );

    // Time-series style aggregation by day (single bucket here)
    const series = await db
      .select({
        day: sql<string>`date_trunc('day', ${aiEngagementEvents.createdAt})::text`,
        impressions: sql<number>`sum(case when ${aiEngagementEvents.eventType} = 'impression' then 1 else 0 end)::int`,
      })
      .from(aiEngagementEvents)
      .where(baseFilter)
      .groupBy(sql`date_trunc('day', ${aiEngagementEvents.createdAt})`);
    const totalImpressions = series.reduce((acc, p) => acc + (p.impressions ?? 0), 0);
    assert(
      "time-series total impressions = 15",
      totalImpressions === 15,
      `got ${totalImpressions}`,
    );
  } finally {
    await db.delete(aiEngagementEvents).where(eq(aiEngagementEvents.organizationId, orgId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }

  console.log("──────────────────────────────────────────────────────────────");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════════════════════════════");
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
