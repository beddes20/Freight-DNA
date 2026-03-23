import cron from "node-cron";
import { storage } from "./storage";
import { sendEmail, baseEmailTemplate, emailEnabled } from "./emailService";

function logMessage(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [daily-digest] ${message}`);
}

function isWeekend(date: Date): boolean {
  const dow = date.getDay();
  return dow === 0 || dow === 6;
}

function daysSince(dateStr: string): number {
  const d = new Date(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

const COLD_THRESHOLD_DAYS = 30;

async function sendDailyDigests(): Promise<void> {
  const today = new Date();
  if (isWeekend(today)) {
    logMessage("Skipping daily digest on weekend.");
    return;
  }

  logMessage("Running daily digest...");

  const defaultOrg = await storage.getDefaultOrganization();
  if (!defaultOrg) { logMessage("No default organization found, skipping."); return; }
  const allUsers = await storage.getUsers(defaultOrg.id);
  const allTasks = await storage.getTasks();
  const allContacts = await storage.getContacts();
  const allTouchpoints = await storage.getTouchpoints ? await storage.getTouchpoints() : [];
  const allCompanies = await storage.getCompanies(defaultOrg.id);
  const companyMap = Object.fromEntries(allCompanies.map(c => [c.id, c]));
  const todayStr = today.toISOString().split("T")[0];

  const reps = allUsers.filter(u => u.role === "account_manager" || u.role === "national_account_manager" || u.role === "sales");
  let digestsSent = 0;

  for (const user of reps) {
    const myTasks = allTasks.filter(t => t.assignedTo === user.id && t.status !== "completed");
    const overdueTasks = myTasks.filter(t => t.dueDate && t.dueDate < todayStr);

    const visibleCompanyIds = allCompanies
      .filter(c => c.assignedTo === user.id && !c.archivedAt)
      .map(c => c.id);

    const myContacts = allContacts.filter(c => visibleCompanyIds.includes(c.companyId));

    const coldContacts: typeof allContacts = [];
    for (const contact of myContacts) {
      const contactTouchpoints = allTouchpoints.filter((tp: any) => tp.contactId === contact.id);
      if (contactTouchpoints.length === 0) {
        coldContacts.push(contact);
      } else {
        const latestDate = contactTouchpoints.map((tp: any) => tp.date).sort().reverse()[0];
        if (daysSince(latestDate) >= COLD_THRESHOLD_DAYS) {
          coldContacts.push(contact);
        }
      }
    }

    if (overdueTasks.length === 0 && coldContacts.length === 0) continue;

    const notifParts: string[] = [];
    if (overdueTasks.length > 0) notifParts.push(`${overdueTasks.length} overdue task${overdueTasks.length > 1 ? "s" : ""}`);
    if (coldContacts.length > 0) notifParts.push(`${coldContacts.length} contact${coldContacts.length > 1 ? "s" : ""} needing attention`);

    const notifTitle = `Daily digest: ${notifParts.join(", ")}`;
    const notifBody = overdueTasks.length > 0
      ? `You have overdue tasks that need your attention today.`
      : `You have contacts that haven't been touched in ${COLD_THRESHOLD_DAYS}+ days.`;

    await storage.createNotification({
      userId: user.id,
      type: "daily_digest",
      title: notifTitle,
      body: notifBody,
      link: "/dashboard",
      read: false,
    });

    if (emailEnabled() && user.username?.includes("@")) {
      let overdueHtml = "";
      if (overdueTasks.length > 0) {
        overdueHtml = `
          <p style="font-weight:600;color:#111827;margin:0 0 10px;">🔴 Overdue Tasks (${overdueTasks.length})</p>
          ${overdueTasks.slice(0, 10).map(t => {
            const company = t.companyId ? companyMap[t.companyId] : null;
            const daysAgo = t.dueDate ? daysSince(t.dueDate) : 0;
            return `<div class="item">
              <div class="item-title">${t.title}</div>
              <div class="item-meta">${company ? `Account: ${company.name} &bull; ` : ""}Due: ${t.dueDate} <span class="badge badge-red">${daysAgo}d overdue</span></div>
            </div>`;
          }).join("")}
          ${overdueTasks.length > 10 ? `<p style="color:#6b7280;font-size:13px;">...and ${overdueTasks.length - 10} more.</p>` : ""}
        `;
      }

      let coldHtml = "";
      if (coldContacts.length > 0) {
        coldHtml = `
          <p style="font-weight:600;color:#111827;margin:${overdueTasks.length > 0 ? "20px" : "0"} 0 10px;">🧊 Contacts Needing Attention (${coldContacts.length})</p>
          ${coldContacts.slice(0, 10).map(c => {
            const company = companyMap[c.companyId];
            return `<div class="item">
              <div class="item-title">${c.name}${c.title ? ` — ${c.title}` : ""}</div>
              <div class="item-meta">Account: ${company?.name ?? "Unknown"}</div>
            </div>`;
          }).join("")}
          ${coldContacts.length > 10 ? `<p style="color:#6b7280;font-size:13px;">...and ${coldContacts.length - 10} more.</p>` : ""}
        `;
      }

      const html = baseEmailTemplate(
        `Daily Digest for ${user.name}`,
        `<p>Good morning ${user.name.split(" ")[0]}! Here's a quick look at what needs your attention today.</p>
        ${overdueHtml}${coldHtml}
        <a class="cta" href="https://sales-org-builder.replit.app/dashboard">Go to Dashboard →</a>`
      );

      await sendEmail({
        to: user.username,
        subject: `[GrowthChart] Daily digest — ${notifParts.join(", ")}`,
        html,
      });
    }

    digestsSent++;
    logMessage(`Digest sent to ${user.name}: ${notifParts.join(", ")}`);
  }

  if (digestsSent === 0) {
    logMessage("No digests needed — all reps are on top of their work!");
  } else {
    logMessage(`Daily digest complete — ${digestsSent} rep(s) notified.`);
  }
}

export function initDailyDigestScheduler(): void {
  const cronExpression = process.env.DAILY_DIGEST_CRON || "0 7 * * 1-5";
  cron.schedule(cronExpression, () => {
    sendDailyDigests().catch(err => logMessage(`Error in daily digest scheduler: ${err.message}`));
  });
  logMessage(`Daily digest scheduler initialized (cron: ${cronExpression})`);
}
