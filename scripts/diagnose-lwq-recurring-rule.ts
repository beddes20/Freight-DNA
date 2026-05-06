/**
 * Task #1085 — Proof script for the LWQ "6× / 30d" UI sync.
 *
 * Reads the canonical `freight_daily_upload_fact` table for the first org we
 * find and prints up to 5 specimen lanes (preferring at least one each of:
 * 5 moves, exactly 6 moves, 8+ moves, and a sparse lane). For each it shows
 * a 60-day weekly histogram, `movesLast30Days`, the derived
 * `avgLoadsPerWeek`, the legacy classification (`avgLoadsPerWeek >= 2`),
 * the new classification (`movesLast30Days >= 6`), and a one-line
 * agreement / disagreement note.
 *
 * Run: `npx tsx scripts/diagnose-lwq-recurring-rule.ts [orgId]`
 */
import { sql } from "drizzle-orm";
import { db } from "../server/storage";

type LaneKey = {
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: string;
};

interface LaneRow extends LaneKey {
  pickupDate: string; // ISO date (YYYY-MM-DD)
}

function laneId(k: LaneKey): string {
  return `${k.originCity},${k.originState} → ${k.destCity},${k.destState} [${k.equipment}]`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function weekBucket(now: Date, d: Date): number {
  const ms = now.getTime() - d.getTime();
  return Math.floor(ms / (7 * 86400_000));
}

async function main() {
  const orgId =
    process.argv[2] ??
    (
      await db.execute<{ org_id: string }>(
        sql`SELECT DISTINCT org_id FROM freight_daily_upload_fact LIMIT 1`,
      )
    ).rows[0]?.org_id;
  if (!orgId) {
    console.error("No org_id found in freight_daily_upload_fact.");
    process.exit(1);
  }
  console.log(`org_id = ${orgId}\n`);

  const now = new Date();
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400_000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400_000);

  const { rows } = await db.execute<{
    origin_city: string;
    origin_state: string;
    dest_city: string;
    dest_state: string;
    equipment: string;
    pickup_date: string;
  }>(sql`
    SELECT origin_city, origin_state, dest_city, dest_state, equipment,
           to_char(pickup_date, 'YYYY-MM-DD') AS pickup_date
      FROM freight_daily_upload_fact
     WHERE org_id = ${orgId}
       AND moved = true
       AND pickup_date >= ${isoDate(sixtyDaysAgo)}
  `);

  // Group by lane key.
  const byLane = new Map<string, LaneRow[]>();
  for (const r of rows) {
    const key: LaneKey = {
      originCity: r.origin_city,
      originState: r.origin_state,
      destCity: r.dest_city,
      destState: r.dest_state,
      equipment: r.equipment,
    };
    const id = laneId(key);
    const arr = byLane.get(id) ?? [];
    arr.push({ ...key, pickupDate: r.pickup_date });
    byLane.set(id, arr);
  }

  type Summary = {
    id: string;
    moves30: number;
    moves60: number;
    avgLoadsPerWeek: number;
    weekly: number[]; // index 0 = current week, 8 = oldest
    legacyEligible: boolean;
    newEligible: boolean;
  };
  const summaries: Summary[] = [];
  for (const [id, lanes] of byLane.entries()) {
    const weekly = new Array(9).fill(0) as number[];
    let moves30 = 0;
    for (const l of lanes) {
      const d = new Date(l.pickupDate + "T12:00:00Z");
      const w = weekBucket(now, d);
      if (w >= 0 && w < weekly.length) weekly[w] += 1;
      if (d >= thirtyDaysAgo) moves30 += 1;
    }
    const avgLoadsPerWeek = Math.round((moves30 / (30 / 7)) * 10) / 10;
    summaries.push({
      id,
      moves30,
      moves60: lanes.length,
      avgLoadsPerWeek,
      weekly,
      legacyEligible: avgLoadsPerWeek >= 2,
      newEligible: moves30 >= 6,
    });
  }

  // Pick specimens: 5 moves, exactly 6, 8+, sparse, plus one extra.
  const pick = (pred: (s: Summary) => boolean) => summaries.find(pred);
  const chosen: Summary[] = [];
  const picks = [
    pick(s => s.moves30 === 5),
    pick(s => s.moves30 === 6),
    pick(s => s.moves30 >= 8),
    pick(s => s.moves30 > 0 && s.moves30 <= 2),
  ];
  for (const p of picks) if (p && !chosen.includes(p)) chosen.push(p);
  for (const s of summaries) {
    if (chosen.length >= 5) break;
    if (!chosen.includes(s)) chosen.push(s);
  }

  if (chosen.length === 0) {
    console.log("(no moved freight_daily_upload_fact rows in last 60d)");
    return;
  }

  for (const s of chosen) {
    const histo = s.weekly
      .map((n, i) => `w-${i}:${n}`)
      .join("  ");
    const note = s.legacyEligible === s.newEligible
      ? "AGREE"
      : s.newEligible && !s.legacyEligible
        ? "DISAGREE — new rule keeps it (≥6/30d), legacy ≥2/wk would drop it"
        : "DISAGREE — legacy ≥2/wk would keep it, new ≥6/30d drops it";
    console.log(`▶ ${s.id}`);
    console.log(`    60d weekly:        ${histo}`);
    console.log(`    movesLast30Days:   ${s.moves30}`);
    console.log(`    avgLoadsPerWeek:   ${s.avgLoadsPerWeek}`);
    console.log(`    legacy ≥2/wk:      ${s.legacyEligible}`);
    console.log(`    new ≥6/30d:        ${s.newEligible}`);
    console.log(`    note:              ${note}\n`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
