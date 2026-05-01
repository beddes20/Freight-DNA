// Task #880 — Leak Console daily snapshot scheduler.
//
// Background: Task #872 shipped the Manager Leak Console with a snapshot
// table (`leak_console_daily_snapshot`) and KPI sparklines that read 14
// trailing rows. The original on-read upsert in routes/leakConsole.ts only
// writes today's row when a manager *visits* the page. That has two gaps:
//
//   1. If no manager opens the console on a given day, that day has no row
//      and the sparklines render with permanent gaps.
//   2. The on-read path only writes for the requesting user's org. Every
//      other org in the system is invisible to the trend until one of its
//      managers visits.
//
// This scheduler closes both gaps by snapshotting every org once at end of
// day (23:55 UTC). The on-read upsert in routes/leakConsole.ts stays as
// defense in depth — same row, same upsert key, last write wins.
//
// Note on backfill: we deliberately do NOT backfill historical days. KPI
// counts are derived from current state of recurring_lanes / freight_
// opportunities / lane_carrier_interest / carrier_outreach_logs. There is
// no point-in-time snapshot of those tables to compute past KPIs from, so
// any historical "snapshot" would just be today's data lying about
// yesterday. The trend fills in naturally over the next 14 days.

import cron from "node-cron";
import { db } from "./storage";
import { organizations, leakConsoleDailySnapshot } from "@shared/schema";
import { computeKpiCounts } from "./leakConsoleService";

function logMessage(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${t} [leak-console-snapshot] ${message}`);
}

export interface SnapshotRunResult {
  orgs: number;
  written: number;
  errors: number;
  errorDetail: Array<{ orgId: string; message: string }>;
  snapshotDate: string;
  durationMs: number;
}

/**
 * Snapshot the Leak Console KPI counts for every org in the system.
 *
 * Idempotent: re-running on the same UTC day overwrites today's row via
 * the (org_id, snapshot_date) primary key. Safe to call from the
 * scheduler, the admin manual-trigger endpoint, or a one-off script.
 *
 * Errors on individual orgs are caught and counted — a single bad org
 * never aborts the whole run.
 */
export async function snapshotAllOrgs(): Promise<SnapshotRunResult> {
  const start = Date.now();
  const snapshotDate = new Date().toISOString().slice(0, 10);
  const orgs = await db.select({ id: organizations.id }).from(organizations);

  let written = 0;
  const errorDetail: Array<{ orgId: string; message: string }> = [];

  for (const org of orgs) {
    try {
      const counts = await computeKpiCounts(org.id);
      await db
        .insert(leakConsoleDailySnapshot)
        .values({
          orgId: org.id,
          snapshotDate,
          noContactableUnderDemand: counts.noContactableUnderDemand,
          unstableSpotDeployed: counts.unstableSpotDeployed,
          recurringCoveredOnSpot: counts.recurringCoveredOnSpot,
          ownedUntouchedUnderPressure: counts.ownedUntouchedUnderPressure,
        })
        .onConflictDoUpdate({
          target: [leakConsoleDailySnapshot.orgId, leakConsoleDailySnapshot.snapshotDate],
          set: {
            noContactableUnderDemand: counts.noContactableUnderDemand,
            unstableSpotDeployed: counts.unstableSpotDeployed,
            recurringCoveredOnSpot: counts.recurringCoveredOnSpot,
            ownedUntouchedUnderPressure: counts.ownedUntouchedUnderPressure,
            computedAt: new Date(),
          },
        });
      written += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errorDetail.push({ orgId: org.id, message });
      logMessage(`org=${org.id} failed: ${message}`);
    }
  }

  return {
    orgs: orgs.length,
    written,
    errors: errorDetail.length,
    errorDetail,
    snapshotDate,
    durationMs: Date.now() - start,
  };
}

/**
 * Initialize the daily snapshot cron. Schedules a single end-of-day run
 * at 23:55 UTC for every org. The on-read upsert in routes/leakConsole.ts
 * remains in place as defense in depth.
 */
export function initLeakConsoleSnapshotScheduler(): void {
  // 23:55 UTC every day — late enough to capture end-of-day state,
  // early enough that even slow runs finish before the UTC date rolls.
  //
  // CRITICAL: pin the cron timezone to UTC explicitly. node-cron defaults
  // to the host's local timezone, which on Replit is usually UTC but is
  // not guaranteed. Without this option the scheduler can fire at the
  // wrong wall-clock minute and (worse) write a snapshotDate that does
  // not match the day the data was actually computed for, since the
  // snapshotDate below is derived from `new Date().toISOString().slice(0, 10)`
  // which IS unconditionally UTC.
  cron.schedule(
    "55 23 * * *",
    async () => {
      logMessage("Running end-of-day snapshot for all orgs...");
      try {
        const result = await snapshotAllOrgs();
        logMessage(
          `Snapshot complete: date=${result.snapshotDate} orgs=${result.orgs} ` +
            `written=${result.written} errors=${result.errors} ` +
            `durationMs=${result.durationMs}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logMessage(`FATAL: snapshot run failed: ${message}`);
      }
    },
    { timezone: "Etc/UTC" },
  );
  logMessage("Scheduler initialized — daily snapshot at 23:55 UTC (Etc/UTC)");
}
