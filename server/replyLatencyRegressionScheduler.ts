/**
 * Weekly reply-latency regression nudge (Task #611).
 *
 * Every Monday morning, walk each org and ask the regression detector which
 * reps' p90 customer-email reply latency just got noticeably worse compared
 * to their trailing baseline. For each flagged rep we drop a single in-app
 * notification linking back to the Response Time analytics page so the rep
 * (and their manager looking over their shoulder) can see the trend chart in
 * context.
 *
 * Why a separate scheduler from the existing coaching digest: the coaching
 * digest is a manager-facing roll-up that fires on a weekly cron with a
 * curated top-3 of items per rep. This nudge fires at the rep themselves the
 * moment their own p90 spikes — different audience, different cadence
 * (could be tightened later), different deduplication key. Bundling them
 * would have meant either letting reps see manager-grade aggregates or
 * suppressing the nudge to avoid duplicating the digest line item.
 *
 * Dedupe is keyed on `${repId}:${weekStart}` via `relatedId`. We use
 * `hasAnyNotification` (not `hasUnreadNotification`) so that a rep who reads
 * + dismisses the nudge does not get re-notified for the same week — read
 * receipts shouldn't spam the inbox.
 */

import cron from "node-cron";
import { storage } from "./storage";
import {
  evaluateOrgRegressions,
  formatDurationMs,
  type RepRegressionFlag,
} from "./services/replyLatencyRegressionService";

const NOTIFICATION_TYPE = "reply_latency_regression";

function log(msg: string): void {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [reply-latency-regression] ${msg}`);
}

/**
 * Build the user-facing notification body for a single regression flag.
 * Pure helper so a unit test can lock the wording without spinning up the DB.
 */
export function buildNotificationCopy(flag: RepRegressionFlag): { title: string; body: string } {
  const pctRounded = Math.round(flag.p90DeltaPct);
  const latestP90 = flag.latest.p90Ms != null ? formatDurationMs(flag.latest.p90Ms) : "—";
  const baseP90 = formatDurationMs(flag.baseline.p90Ms);
  const basis = flag.businessHours ? "business-hour" : "wall-clock";
  return {
    title: `⏱️ Your reply speed slipped ${pctRounded}% last week`,
    body:
      `Your p90 ${basis} reply time for the week of ${flag.latest.weekStart} was ${latestP90} ` +
      `across ${flag.latest.count} replies — up from a ${baseP90} baseline ` +
      `over the prior ${flag.baseline.weeks.length} week(s). Open Response Time to see which threads ran long.`,
  };
}

export async function runReplyLatencyRegressionSweep(now: Date = new Date()): Promise<number> {
  const orgs = await storage.getOrganizations();
  if (orgs.length === 0) {
    log("No organisations found, skipping.");
    return 0;
  }

  let totalNotified = 0;

  for (const org of orgs) {
    try {
      const { config, latestWeekStart, flags } = await evaluateOrgRegressions(org.id, { now });
      if (!config.enabled) {
        log(`org=${org.id} disabled — skipping.`);
        continue;
      }
      if (flags.length === 0) {
        log(`org=${org.id} week=${latestWeekStart}: no regressions detected.`);
        continue;
      }

      // Cross-check that the flagged repId is still a live user in the org —
      // attribution can resolve to ex-employees whose threads are still being
      // forwarded, and we don't want to insert orphan notifications keyed to a
      // deleted user (the FK would error and abort the batch).
      const orgUsers = await storage.getUsers(org.id);
      const userById = new Map(orgUsers.map(u => [u.id, u]));

      let notifiedForOrg = 0;
      for (const flag of flags) {
        const user = userById.get(flag.repId);
        if (!user) {
          log(`org=${org.id} rep=${flag.repId} not in users table — skipping`);
          continue;
        }

        const relatedId = `${flag.repId}:${flag.latest.weekStart}`;
        const alreadyFired = await storage.hasAnyNotification(user.id, NOTIFICATION_TYPE, relatedId);
        if (alreadyFired) continue;

        const { title, body } = buildNotificationCopy(flag);
        try {
          await storage.createNotification({
            userId: user.id,
            type: NOTIFICATION_TYPE,
            title,
            body,
            link: "/email-response-time",
            read: false,
            relatedId,
          });
          notifiedForOrg++;
        } catch (err) {
          log(`org=${org.id} rep=${user.id} createNotification failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      totalNotified += notifiedForOrg;
      log(`org=${org.id} week=${latestWeekStart}: flagged ${flags.length} rep(s), notified ${notifiedForOrg}.`);
    } catch (orgErr) {
      log(`org=${org.id} error: ${orgErr instanceof Error ? orgErr.message : orgErr}`);
    }
  }

  log(`Sweep complete — ${totalNotified} notification(s) created across ${orgs.length} org(s).`);
  return totalNotified;
}

export function initReplyLatencyRegressionScheduler(): void {
  // Monday 7:30 AM America/Chicago by default — runs after the momentum
  // digest at 7:00 so the two notifications don't show up at the same second.
  // Override via env in case an org wants to test on a different cadence.
  const cronExpression = process.env.REPLY_LATENCY_REGRESSION_CRON || "30 7 * * 1";
  cron.schedule(cronExpression, () => {
    runReplyLatencyRegressionSweep().catch(err =>
      log(`Scheduler error: ${err instanceof Error ? err.message : err}`),
    );
  }, { timezone: "America/Chicago" });
  log(`Scheduler initialized (cron: ${cronExpression}, tz: America/Chicago)`);
}
