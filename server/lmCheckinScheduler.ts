import cron from "node-cron";
import { storage } from "./storage";

const pool = (storage as any).pool;

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
  console.log(`${t} CT [lm-checkin] ${msg}`);
}

/**
 * Returns today's date string (YYYY-MM-DD) in America/Chicago time.
 * Using UTC toISOString() would give the wrong date for CT users late in the evening.
 */
function getTodayCT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

async function fireCheckinAlerts(checkType: "morning" | "afternoon") {
  const ctTime = new Date().toLocaleTimeString("en-US", {
    timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: true,
  });
  log(`Firing ${checkType} alerts (CT clock: ${ctTime})`);

  try {
    // Find all users who have logistics_managers or logistics_coordinators directly
    // reporting to them. Targets: admin, director, NAM, AM, sales, sales_director.
    const result = await pool.query(`
      SELECT DISTINCT u.id, u.name, u.organization_id
      FROM users u
      WHERE u.organization_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM users lm
          WHERE lm.manager_id = u.id
            AND lm.organization_id = u.organization_id
            AND lm.role IN ('logistics_manager','logistics_coordinator')
        )
        AND u.role IN ('admin','director','national_account_manager','account_manager','sales','sales_director')
    `);

    const today = getTodayCT();
    let notified = 0;
    let skipped = 0;

    for (const reviewer of result.rows) {
      // Duplicate guard: skip if they already submitted today's check of this type.
      // This prevents re-alerting if the cron fires more than once (e.g. server restart).
      const existing = await pool.query(
        `SELECT 1 FROM nam_lm_checkins
         WHERE reviewer_id = $1 AND check_date = $2 AND check_type = $3
         LIMIT 1`,
        [reviewer.id, today, checkType]
      );
      if ((existing.rowCount ?? 0) > 0) {
        skipped++;
        continue;
      }

      // Also skip if a notification of this type was already sent today.
      const notifExists = await pool.query(
        `SELECT 1 FROM notifications
         WHERE user_id = $1 AND type = 'lm_checkin'
           AND created_at::date = $2::date
           AND title LIKE $3
         LIMIT 1`,
        [reviewer.id, today, checkType === "morning" ? "%7:30%morning%" : "%4:00%afternoon%"]
      );
      if ((notifExists.rowCount ?? 0) > 0) {
        skipped++;
        continue;
      }

      const label = checkType === "morning"
        ? "⏰ Morning LM Check — 7:30 AM"
        : "🕓 Afternoon LM Check — 4:00 PM";
      const body = checkType === "morning"
        ? "Have LM check calls been completed and is the board clean by 7:30?"
        : "Is the checkout process complete and is the board clean for the day?";

      await storage.createNotification({
        userId: reviewer.id,
        type: "lm_checkin",
        title: label,
        body,
        link: "/dashboard",
        read: false,
      });
      notified++;
    }

    log(`${checkType} done — ${notified} notified, ${skipped} skipped (already submitted or already notified), ${result.rows.length} total reviewers checked`);
  } catch (err: any) {
    log(`Error firing ${checkType} alerts: ${err?.message}`);
  }
}

export function initLmCheckinScheduler() {
  // node-cron interprets cron expressions in the given timezone.
  // Both jobs run Mon–Fri only (field 5: 1-5).
  // Timezone: America/Chicago covers both CST (UTC-6) and CDT (UTC-5) automatically.

  // 7:30 AM CT, Mon–Fri
  cron.schedule("30 7 * * 1-5", () => fireCheckinAlerts("morning"), {
    timezone: "America/Chicago",
  });

  // 4:00 PM CT, Mon–Fri
  cron.schedule("0 16 * * 1-5", () => fireCheckinAlerts("afternoon"), {
    timezone: "America/Chicago",
  });

  log("LM check-in scheduler initialized — morning: 7:30 AM CT, afternoon: 4:00 PM CT, Mon–Fri only");
}
