import cron from "node-cron";
import { storage } from "./storage";
import { sendEmail, baseEmailTemplate, emailEnabled } from "./emailService";

function logMessage(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [rfp-deadline] ${message}`);
}

function daysBetween(dateStr: string): number {
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  } catch {
    return dateStr;
  }
}

const THRESHOLDS = [7, 3, 1];

async function checkRfpDeadlines(): Promise<void> {
  logMessage("Running RFP deadline check...");

  const allRfps = await storage.getRfps();
  const allCompanies = await storage.getCompanies();
  const allUsers = await storage.getUsers();

  const companyMap = Object.fromEntries(allCompanies.map(c => [c.id, c]));
  const userMap = Object.fromEntries(allUsers.map(u => [u.id, u]));

  const adminsAndDirectors = allUsers.filter(u => u.role === "admin" || u.role === "director");

  let notificationsCreated = 0;

  for (const rfp of allRfps) {
    if (!rfp.dueDate) continue;
    if (rfp.status === "awarded" || rfp.status === "declined" || rfp.status === "closed") continue;

    const days = daysBetween(rfp.dueDate);
    if (!THRESHOLDS.includes(days)) continue;

    const settingKey = `rfp_deadline_alert_${rfp.id}_${days}d`;
    const alreadySent = await storage.getSetting(settingKey);
    if (alreadySent === "1") continue;

    const company = companyMap[rfp.companyId];
    const companyName = company?.name ?? "Unknown Account";
    const dueDateFmt = formatDate(rfp.dueDate);

    const urgencyLabel = days === 1 ? "⚠️ Due TOMORROW" : days === 3 ? "⏰ Due in 3 days" : "📅 Due in 7 days";
    const badgeColor = days === 1 ? "badge-red" : days === 3 ? "badge-amber" : "badge-blue";

    const notifTitle = `${urgencyLabel}: "${rfp.title}" for ${companyName}`;
    const notifBody = `Response due ${dueDateFmt}. Don't let this one slip.`;
    const notifLink = `/companies/${rfp.companyId}`;

    const recipientIds = new Set<string>();

    if (company?.assignedTo) {
      recipientIds.add(company.assignedTo);
      const am = userMap[company.assignedTo];
      if (am?.managerId) {
        recipientIds.add(am.managerId);
        const nam = userMap[am.managerId];
        if (nam?.managerId) recipientIds.add(nam.managerId);
      }
    }

    for (const u of adminsAndDirectors) recipientIds.add(u.id);

    for (const userId of recipientIds) {
      const user = userMap[userId];
      if (!user) continue;

      await storage.createNotification({
        userId,
        type: "rfp_deadline",
        title: notifTitle,
        body: notifBody,
        link: notifLink,
        read: false,
        relatedId: rfp.id,
      });

      if (emailEnabled() && user.username?.includes("@")) {
        const html = baseEmailTemplate(
          `RFP Deadline Alert — ${companyName}`,
          `
          <p>This is a reminder that an RFP response deadline is approaching.</p>
          <div class="item">
            <div class="item-title">${rfp.title}</div>
            <div class="item-meta">Account: ${companyName}</div>
            <div class="item-meta" style="margin-top:8px;">
              <span class="badge ${badgeColor}">${urgencyLabel}</span>
              &nbsp; Due: <strong>${dueDateFmt}</strong>
            </div>
          </div>
          <p>Log in to Growth Chart VT to review the RFP details and ensure your team is on track.</p>
          <a class="cta" href="https://sales-org-builder.replit.app${notifLink}">View RFP →</a>
          `
        );
        await sendEmail({ to: user.username, subject: `[GrowthChart] ${urgencyLabel}: "${rfp.title}"`, html });
      }

      notificationsCreated++;
    }

    await storage.setSetting(settingKey, "1");
    logMessage(`Sent ${days}-day deadline alert for RFP "${rfp.title}" (${companyName}) to ${recipientIds.size} recipients`);
  }

  if (notificationsCreated === 0) {
    logMessage("No RFP deadline alerts needed today.");
  } else {
    logMessage(`RFP deadline check complete — ${notificationsCreated} notifications sent.`);
  }
}

export function initRfpDeadlineScheduler(): void {
  const cronExpression = process.env.RFP_DEADLINE_CRON || "0 8 * * *";
  cron.schedule(cronExpression, () => {
    checkRfpDeadlines().catch(err => logMessage(`Error in RFP deadline scheduler: ${err.message}`));
  });
  logMessage(`RFP deadline scheduler initialized (cron: ${cronExpression})`);

  checkRfpDeadlines().catch(err => logMessage(`Error in startup RFP deadline check: ${err.message}`));
}
