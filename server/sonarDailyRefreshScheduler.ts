/**
 * Sonar Daily Refresh Scheduler — Task #465
 *
 * Replaces the previous every-2-hours national/market pull. Runs once per day
 * at 4:30 AM Central, force-refreshes the national OTRI/NTI/VCRPM1 snapshot
 * and a list of top markets, and writes them to the DB-backed cache. Every
 * downstream consumer (daily digest, market-pulse endpoint, intel dashboard,
 * copilot national-rates tool) reads from that cached snapshot for the rest
 * of the day — TTLs are 25 hours so no consumer triggers its own live pull.
 *
 * On a null/empty result, fires admin notifications so we catch the next
 * outage in minutes instead of by accident.
 */

import cron from "node-cron";
import {
  runDailySonarRefresh,
  getSonarDailyPullStatus,
  getSonarCircuitBreakerStatus,
  withSonarCaller,
} from "./sonarClient";
import { notifyAdminsOfSystemEvent, checkBreakerLongOpen } from "./sonarAlertNotifier";
import { JOB_NAMES, withHeartbeat } from "./lib/cronHeartbeat";

function log(msg: string) {
  const t = new Date().toISOString();
  console.log(`[sonar-daily] ${t} ${msg}`);
}

async function notifyAdminsOfFailure(summary: string): Promise<void> {
  await notifyAdminsOfSystemEvent({
    relatedIdPrefix: "sonar_daily_failure",
    title: "Sonar daily pull returned no data",
    body: summary,
    link: "/api/sonar/health",
  });
}

export async function runSonarDailyRefreshNow(): Promise<void> {
  log("Starting daily Sonar refresh…");
  try {
    const status = await withSonarCaller("scheduler:daily-refresh", () => runDailySonarRefresh());
    const summary = `national=${status.nationalOk ? "OK" : "FAIL"} markets=${status.marketsOk}/${status.marketsAttempted}`;
    if (!status.nationalOk && status.marketsOk === 0) {
      log(`⚠ Daily refresh returned NO DATA — ${summary}${status.lastError ? ` (${status.lastError})` : ""}`);
      await notifyAdminsOfFailure(`${summary}${status.lastError ? ` — ${status.lastError}` : ""}`);
    } else {
      log(`Daily refresh complete — ${summary}`);
    }
  } catch (err: any) {
    log(`FATAL: ${err?.message ?? err}`);
    await notifyAdminsOfFailure(`Scheduler crashed: ${err?.message ?? err}`);
  }
}

export function initSonarDailyRefreshScheduler(): void {
  // 4:30 AM Central — early enough that the daily digest (which runs after
  // 6 AM in most schedulers) sees fresh data.
  cron.schedule("30 4 * * *", runSonarDailyRefreshNow, { timezone: "America/Chicago" });
  log("Sonar daily refresh scheduler registered (4:30 AM CT)");

  // Run once shortly after boot if we have no successful pull on record yet
  // OR the last successful pull was more than 26h ago — keeps dev-restart
  // cycles fresh and ensures a brand-new prod deploy doesn't wait until 4 AM.
  setTimeout(async () => {
    try {
      const status = getSonarDailyPullStatus();
      const lastMs = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : 0;
      if (Date.now() - lastMs > 26 * 60 * 60 * 1000) {
        log("No recent successful pull — running boot refresh");
        await runSonarDailyRefreshNow();
      }
    } catch (err: any) {
      log(`Boot refresh check error (non-fatal): ${err?.message ?? err}`);
    }
  }, 30_000);

  // Long-open breaker monitor (Task #740): every 5 minutes, check whether the
  // SONAR circuit breaker has been open for ≥60 minutes during business
  // hours and notify admins once per breaker-open episode. Cron-anchored and
  // heartbeated — was previously setInterval(5min) which reset on every
  // workflow restart and left no liveness signal.
  const BREAKER_POLL_MS = 5 * 60 * 1000;
  cron.schedule("*/5 * * * *", () => {
    void withHeartbeat(JOB_NAMES.sonarBreakerLongOpenPoll, BREAKER_POLL_MS, async () => {
      try {
        await checkBreakerLongOpen(getSonarCircuitBreakerStatus());
      } catch (err: any) {
        log(`Breaker long-open check error (non-fatal): ${err?.message ?? err}`);
        throw err;
      }
    });
  });
  log("Sonar long-open breaker monitor registered (5-min cron, clock-anchored)");
}
