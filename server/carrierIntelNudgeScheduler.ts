/**
 * Carrier Intel daily rep nudge (Task #769).
 *
 * Weekday morning summary of pending carrier intel suggestions per rep.
 *  - Sends a single email with the count + deep link to /carrier-hub.
 *  - Creates an in-app notification (sidebar bell).
 *  - Sends a Webex direct message if WEBEX_BOT_TOKEN is configured and
 *    the user's username is an email.
 *  - Skips reps with zero pending suggestions.
 *  - Skips entirely when the org-level dailyNudgeEnabled flag is off.
 */
import cron from "node-cron";
import { storage } from "./storage";
import { sendEmail, baseEmailTemplate, emailEnabled } from "./emailService";
import { sendWebexDirectMessage, webexBotConfigured } from "./webexService";
import { getNeedsReviewSettings } from "./services/carrierIntelSuggestionExpiration";

function logMessage(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${t} [carrier-intel-nudge] ${message}`);
}

function isWeekend(date: Date): boolean {
  const dow = date.getDay();
  return dow === 0 || dow === 6;
}

function appUrl(): string {
  return process.env.APP_URL?.replace(/\/$/, "") ?? "https://sales-org-builder.replit.app";
}

interface PendingByRepRow {
  user_id: string;
  pending_count: string;
}

/**
 * Aggregate pending carrier intel suggestions by responsible rep, derived
 * from the most-recent outreach log actor/owner per carrier. Falls back to
 * the company.assignedTo for the linked account when no outreach exists.
 */
async function getPendingCountsByRep(orgId: string): Promise<Map<string, number>> {
  const result = await storage.pool.query<PendingByRepRow>(
    `WITH pending AS (
        SELECT cis.id, cis.carrier_id
          FROM carrier_intel_suggestions cis
         WHERE cis.org_id = $1 AND cis.status = 'pending'
     ),
     latest_outreach AS (
        SELECT DISTINCT ON (carrier_id) carrier_id, owner_user_id, actor_user_id
          FROM (
            SELECT unnest(col.carrier_ids) AS carrier_id,
                   col.owner_user_id, col.actor_user_id, col.timestamp
              FROM carrier_outreach_logs col
             WHERE col.timestamp IS NOT NULL
          ) sub
         ORDER BY carrier_id, timestamp DESC
     )
     SELECT COALESCE(lo.owner_user_id, lo.actor_user_id) AS user_id,
            COUNT(*)::text AS pending_count
       FROM pending p
       LEFT JOIN latest_outreach lo ON lo.carrier_id = p.carrier_id
      WHERE COALESCE(lo.owner_user_id, lo.actor_user_id) IS NOT NULL
      GROUP BY COALESCE(lo.owner_user_id, lo.actor_user_id)`,
    [orgId],
  );
  const map = new Map<string, number>();
  for (const row of result.rows) {
    const n = parseInt(row.pending_count, 10);
    if (Number.isFinite(n) && n > 0) map.set(row.user_id, n);
  }
  return map;
}

const NUDGE_ELIGIBLE_ROLES = new Set([
  "admin",
  "director",
  "national_account_manager",
  "account_manager",
  "sales",
]);

async function sendNudgesForOrg(orgId: string): Promise<void> {
  const settings = await getNeedsReviewSettings(orgId);
  if (!settings.dailyNudgeEnabled) {
    logMessage(`org ${orgId}: daily nudge disabled, skipping`);
    return;
  }

  const counts = await getPendingCountsByRep(orgId);
  if (counts.size === 0) {
    logMessage(`org ${orgId}: no pending carrier intel — no nudges to send`);
    return;
  }

  const users = await storage.getUsers(orgId);
  const usersById = new Map(users.map((u: any) => [u.id, u]));
  const link = `${appUrl()}/carrier-hub?hasPendingIntel=true`;

  let sent = 0;
  let webexAttempted = 0;
  for (const [userId, count] of counts.entries()) {
    if (count <= 0) continue;
    const user: any = usersById.get(userId);
    if (!user) continue;
    if (!NUDGE_ELIGIBLE_ROLES.has(user.role ?? "")) continue;

    const firstName = (user.name ?? "").split(" ")[0] || "there";
    const subject = `[Carrier Hub] ${count} carrier intel suggestion${count === 1 ? "" : "s"} need your review`;
    const text = `Good morning, ${firstName}. You have ${count} pending carrier intel suggestion${count === 1 ? "" : "s"} waiting for review. Open Carrier Hub: ${link}`;

    try {
      await storage.createNotification({
        userId: user.id,
        type: "carrier_intel_nudge",
        title: `${count} carrier intel suggestion${count === 1 ? "" : "s"} to review`,
        body: `Open Carrier Hub to accept, reject, or accept-all from a carrier in one click.`,
        link: "/carrier-hub?hasPendingIntel=true",
        read: false,
      });
    } catch (err) {
      logMessage(`org ${orgId}: notification create failed for ${user.id}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (emailEnabled() && typeof user.username === "string" && user.username.includes("@")) {
      try {
        const html = baseEmailTemplate(
          `Carrier Hub — ${count} suggestion${count === 1 ? "" : "s"} to review`,
          `<p>Good morning, ${firstName}.</p>
           <p>You have <strong>${count}</strong> pending carrier intel suggestion${count === 1 ? "" : "s"} waiting for your review. Most clear in seconds — and you can now bulk-accept or "accept all from this carrier" in one click.</p>
           <a class="cta" href="${link}">Open Carrier Hub →</a>
           <p style="color:#6b7280;font-size:12px;margin-top:24px;">You're receiving this because you're the active rep on at least one carrier with pending intel. Admins can disable this nudge in Admin → Carrier Intelligence.</p>`,
        );
        await sendEmail({ to: user.username, subject, html });
      } catch (err) {
        logMessage(`org ${orgId}: email send failed for ${user.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (webexBotConfigured() && typeof user.username === "string" && user.username.includes("@")) {
      webexAttempted++;
      try {
        const markdown = `**Carrier Hub — ${count} suggestion${count === 1 ? "" : "s"} to review**\n\nGood morning, ${firstName}. You have **${count}** pending carrier intel suggestion${count === 1 ? "" : "s"} waiting. [Open Carrier Hub](${link})`;
        await sendWebexDirectMessage({ toEmail: user.username, text, markdown });
      } catch (err) {
        logMessage(`org ${orgId}: webex DM failed for ${user.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    sent++;
  }

  logMessage(`org ${orgId}: nudges sent to ${sent} rep(s) (webex attempted ${webexAttempted})`);
}

export async function runCarrierIntelNudges(): Promise<void> {
  const today = new Date();
  if (isWeekend(today)) {
    logMessage("Skipping nudges on weekend.");
    return;
  }
  const orgs = await storage.getOrganizations();
  for (const org of orgs) {
    try {
      await sendNudgesForOrg(org.id);
    } catch (err) {
      logMessage(`org ${org.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function initCarrierIntelNudgeScheduler(): void {
  // Default 7:15am every weekday. Overridable via env so an org can shift it.
  const cronExpression = process.env.CARRIER_INTEL_NUDGE_CRON || "15 7 * * 1-5";
  cron.schedule(cronExpression, () => {
    runCarrierIntelNudges().catch(err =>
      logMessage(`Error in nudge scheduler: ${err instanceof Error ? err.message : String(err)}`),
    );
  });
  logMessage(`Carrier intel nudge scheduler initialized (cron: ${cronExpression})`);
}
