/**
 * Quote Lost-Streak Scheduler (Task #478)
 *
 * Runs every 6 hours. For each org:
 *   1. Computes per-customer and per-lane-group consecutive-loss streaks
 *      (defaults: ≥5 losses in a 60-day rolling window — overridable via
 *      QUOTE_LOST_STREAK_THRESHOLD / QUOTE_LOST_STREAK_WINDOW_DAYS).
 *   2. For each fired streak, notifies admins, the org's directors, and any
 *      sales rep linked to a quote in that streak (via quoteReps.userId).
 *   3. Dedupes per-recipient using `relatedId = <stable streak key>` so each
 *      streak fires once and does not re-notify on every additional loss.
 *      The streak key embeds the earliest loss id, so a new streak after a
 *      win will produce a new key and re-notify.
 *
 * The streak alerts also surface in the Customer Quotes alerts panel (see
 * `getSnapshot` in services/customerQuotes.ts) with a click-through to a
 * pre-filtered (customer or lane-group, lostOnly) quote list.
 */

import { storage } from "./storage";
import { db } from "./storage";
import { quoteReps } from "@shared/schema";
import { eq } from "drizzle-orm";
import { loadLostStreakAlertsForOrg } from "./services/customerQuotes";

function log(msg: string): void {
  console.log(`[quote-lost-streak] ${new Date().toISOString()} ${msg}`);
}

export async function runLostStreakAlertsForOrg(orgId: string): Promise<{ fired: number; notified: number; skipped: number }> {
  const alerts = await loadLostStreakAlertsForOrg(orgId);
  if (alerts.length === 0) return { fired: 0, notified: 0, skipped: 0 };

  // Map repId -> userId via quote_reps (only reps that are linked to a CRM user).
  const reps = await db.select().from(quoteReps).where(eq(quoteReps.organizationId, orgId));
  const repToUser = new Map<string, string>();
  for (const r of reps) if (r.userId) repToUser.set(r.id, r.userId);

  const users = await storage.getUsers(orgId).catch(() => [] as Awaited<ReturnType<typeof storage.getUsers>>);
  const adminIds = new Set<string>();
  for (const u of users) {
    const role = (u as { role?: string }).role;
    if (role === "admin" || role === "director" || role === "manager") adminIds.add(u.id);
  }

  let notified = 0;
  let skipped = 0;

  for (const sa of alerts) {
    const recipients = new Set<string>(adminIds);
    for (const repId of sa.recentRepIds) {
      const uid = repToUser.get(repId);
      if (uid) recipients.add(uid);
    }
    if (recipients.size === 0) { skipped++; continue; }

    const link = sa.kind === "customer"
      ? `/customer-quotes?customerId=${encodeURIComponent(sa.customerId ?? "")}&lostOnly=true`
      : `/customer-quotes?laneGroupId=${encodeURIComponent(sa.laneGroupId ?? "")}&lostOnly=true`;

    for (const userId of recipients) {
      try {
        const seen = await storage.hasAnyNotification(userId, "system", sa.dedupeKey).catch(() => false);
        if (seen) { skipped++; continue; }
        await storage.createNotification({
          userId,
          type: "system",
          title: sa.alert.title,
          body: sa.alert.detail,
          link,
          relatedId: sa.dedupeKey,
          read: false,
        });
        notified++;
      } catch (err) {
        log(`notify failed user=${userId} key=${sa.dedupeKey}: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  return { fired: alerts.length, notified, skipped };
}

export async function runLostStreakAlertsForAllOrgs(): Promise<void> {
  log("Scanning all orgs for lost-streak alerts…");
  try {
    const orgs = await storage.getOrganizations?.().catch(() => []) ?? [];
    let totalFired = 0;
    let totalNotified = 0;
    for (const org of orgs) {
      try {
        const r = await runLostStreakAlertsForOrg(org.id);
        if (r.fired > 0) {
          log(`org=${org.id} fired=${r.fired} notified=${r.notified} skipped=${r.skipped}`);
          totalFired += r.fired;
          totalNotified += r.notified;
        }
      } catch (err) {
        log(`org=${org.id} ERROR: ${(err as Error)?.message ?? err}`);
      }
    }
    log(`Pass complete — totalFired=${totalFired} totalNotified=${totalNotified}`);
  } catch (err) {
    log(`FATAL: ${(err as Error)?.message ?? err}`);
  }
}

export async function initQuoteLostStreakScheduler(): Promise<void> {
  const cron = (await import("node-cron")).default;
  // Every 6 hours, at :20 past the hour. Aligns with the spec (alerts loudly
  // and promptly without waiting for the nightly batch) but stays clear of the
  // 3:00 AM nightly run that already touches quote data.
  cron.schedule("20 */6 * * *", () => {
    runLostStreakAlertsForAllOrgs().catch((err) => log(`schedule error: ${(err as Error)?.message ?? err}`));
  });
  log("Scheduler initialized (every 6h at :20).");
}
