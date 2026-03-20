import cron from "node-cron";
import { storage } from "./storage";
import { sendEmail, emailEnabled, buildRepReportEmail } from "./emailService";

function logMessage(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [rep-report] ${msg}`);
}

const PORTAL_BASE = process.env.APP_URL || "https://sales-org-builder.replit.app";

async function sendReportToUser(userId: string, period: "weekly" | "monthly"): Promise<boolean> {
  const allUsers = await storage.getUsers();
  const user = allUsers.find(u => u.id === userId);
  if (!user) return false;

  const email = (user as any).email || (user.username?.includes("@") ? user.username : null);
  if (!email) {
    logMessage(`Skipping ${user.name} — no email address configured`);
    return false;
  }

  const data = await storage.getRepReport(userId, period);
  const html = buildRepReportEmail({
    ...data,
    portalUrl: `${PORTAL_BASE}/report/${userId}`,
  });

  const isWeekly = period === "weekly";
  const subject = isWeekly
    ? `[Growth Chart] Weekly Report — ${data.rep.name} — ${data.period.label}`
    : `[Growth Chart] Monthly Report — ${data.rep.name} — ${data.period.label}`;

  return sendEmail({ to: email, subject, html });
}

async function sendWeeklyReports(): Promise<void> {
  if (!emailEnabled()) {
    logMessage("Email not configured — skipping weekly reports");
    return;
  }
  logMessage("Sending weekly progress reports...");
  const allUsers = await storage.getUsers();
  const reps = allUsers.filter(u =>
    u.role === "account_manager" || u.role === "national_account_manager" ||
    u.role === "sales" || u.role === "logistics_manager"
  );
  let sent = 0;
  for (const rep of reps) {
    const ok = await sendReportToUser(rep.id, "weekly");
    if (ok) sent++;
  }
  logMessage(`Weekly reports complete — ${sent}/${reps.length} sent`);
}

async function sendMonthlyReports(): Promise<void> {
  if (!emailEnabled()) {
    logMessage("Email not configured — skipping monthly reports");
    return;
  }
  logMessage("Sending monthly progress reports...");
  const allUsers = await storage.getUsers();
  const reps = allUsers.filter(u =>
    u.role === "account_manager" || u.role === "national_account_manager" ||
    u.role === "sales" || u.role === "logistics_manager"
  );
  let sent = 0;
  for (const rep of reps) {
    const ok = await sendReportToUser(rep.id, "monthly");
    if (ok) sent++;
  }
  logMessage(`Monthly reports complete — ${sent}/${reps.length} sent`);
}

export async function sendRepReportEmail(userId: string, period: "weekly" | "monthly"): Promise<boolean> {
  return sendReportToUser(userId, period);
}

export function initRepReportScheduler(): void {
  const weeklyCron = process.env.REP_REPORT_WEEKLY_CRON || "0 7 * * 1";
  const monthlyCron = process.env.REP_REPORT_MONTHLY_CRON || "0 7 1 * *";

  cron.schedule(weeklyCron, () => {
    sendWeeklyReports().catch(err => logMessage(`Error in weekly reports: ${err.message}`));
  });
  cron.schedule(monthlyCron, () => {
    sendMonthlyReports().catch(err => logMessage(`Error in monthly reports: ${err.message}`));
  });
  logMessage(`Rep report scheduler initialized (weekly: ${weeklyCron}, monthly: ${monthlyCron})`);
}
