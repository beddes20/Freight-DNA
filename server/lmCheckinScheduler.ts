import cron from "node-cron";
import { storage } from "./storage";

const pool = (storage as any).pool;

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  console.log(`${t} [lm-checkin] ${msg}`);
}

async function fireCheckinAlerts(checkType: "morning" | "afternoon") {
  try {
    // Find all users who have logistics_managers or logistics_coordinators directly reporting to them
    const result = await pool.query<{ id: string; name: string; organization_id: string }>(`
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

    const today = new Date().toISOString().slice(0, 10);
    let notified = 0;

    for (const reviewer of result.rows) {
      // Skip if they already submitted today's check of this type
      const existing = await pool.query(
        `SELECT 1 FROM nam_lm_checkins
         WHERE reviewer_id = $1 AND check_date = $2 AND check_type = $3
         LIMIT 1`,
        [reviewer.id, today, checkType]
      );
      if ((existing.rowCount ?? 0) > 0) continue;

      const label = checkType === "morning"
        ? "⏰ 7:30 AM LM Check-In Due"
        : "🕓 4:00 PM LM Check-In Due";
      const body = checkType === "morning"
        ? "Did your LMs complete check calls? Is the board clean?"
        : "Did your LMs complete checkout? Is the board clean?";

      await storage.createNotification({
        userId: reviewer.id,
        type: "lm_checkin",
        title: label,
        body,
        link: "/coordinators-corner?checkin=1",
        read: false,
      });
      notified++;
    }

    log(`${checkType} alerts sent to ${notified} reviewers`);
  } catch (err: any) {
    log(`Error firing ${checkType} alerts: ${err?.message}`);
  }
}

export function initLmCheckinScheduler() {
  // 7:30 AM CT, Mon–Fri
  cron.schedule("30 7 * * 1-5", () => fireCheckinAlerts("morning"), { timezone: "America/Chicago" });
  // 4:00 PM CT, Mon–Fri
  cron.schedule("0 16 * * 1-5", () => fireCheckinAlerts("afternoon"), { timezone: "America/Chicago" });
  log("LM check-in scheduler initialized (7:30 AM + 4:00 PM CT, Mon–Fri)");
}
