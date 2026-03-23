import cron from "node-cron";
import { storage } from "./storage";
import { sendEmail, emailEnabled, buildRepReportEmail } from "./emailService";

function logMessage(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [rep-report] ${msg}`);
}

const PORTAL_BASE = process.env.APP_URL || "https://sales-org-builder.replit.app";

async function sendReportToUser(userId: string, period: "weekly" | "monthly"): Promise<{ ok: boolean; email: string | null }> {
  const defaultOrg = await storage.getDefaultOrganization();
  const allUsers = defaultOrg ? await storage.getUsers(defaultOrg.id) : [];
  const user = allUsers.find(u => u.id === userId);
  if (!user) return { ok: false, email: null };

  const email = (user as any).email || user.username;
  if (!email) {
    logMessage(`Skipping ${user.name} — no username/email configured`);
    return { ok: false, email: null };
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

  const ok = await sendEmail({ to: email, subject, html });
  return { ok, email };
}

async function sendWeeklyReports(): Promise<void> {
  if (!emailEnabled()) {
    logMessage("Email not configured — skipping weekly reports");
    return;
  }
  logMessage("Sending weekly progress reports...");
  const defaultOrg = await storage.getDefaultOrganization(); const allUsers = defaultOrg ? await storage.getUsers(defaultOrg.id) : [];
  const reps = allUsers.filter(u =>
    u.role === "account_manager" || u.role === "national_account_manager" ||
    u.role === "sales" || u.role === "logistics_manager"
  );
  let sent = 0;
  for (const rep of reps) {
    const { ok } = await sendReportToUser(rep.id, "weekly");
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
  const defaultOrg = await storage.getDefaultOrganization(); const allUsers = defaultOrg ? await storage.getUsers(defaultOrg.id) : [];
  const reps = allUsers.filter(u =>
    u.role === "account_manager" || u.role === "national_account_manager" ||
    u.role === "sales" || u.role === "logistics_manager"
  );
  let sent = 0;
  for (const rep of reps) {
    const { ok } = await sendReportToUser(rep.id, "monthly");
    if (ok) sent++;
  }
  logMessage(`Monthly reports complete — ${sent}/${reps.length} sent`);
}

export async function sendRepReportEmail(userId: string, period: "weekly" | "monthly"): Promise<{ ok: boolean; email: string | null }> {
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
