import cron from "node-cron";
import { storage } from "./storage";
import { sendEmail, emailEnabled, baseEmailTemplate } from "./emailService";

function logMessage(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [1on1-reminder] ${msg}`);
}

const PORTAL_BASE = process.env.APP_URL || "https://sales-org-builder.replit.app";

function formatDateFriendly(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function getDaysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const meeting = new Date(dateStr + "T12:00:00");
  meeting.setHours(0, 0, 0, 0);
  return Math.round((meeting.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function buildReminderEmail(params: {
  recipientName: string;
  partnerName: string;
  meetingDate: string;
  pendingCount: number;
  portalUrl: string;
  daysUntil: number;
}): string {
  const { recipientName, partnerName, meetingDate, pendingCount, portalUrl, daysUntil } = params;
  const urgency = daysUntil === 0
    ? "Your 1:1 is <strong>today!</strong>"
    : daysUntil === 1
    ? "Your 1:1 is <strong>tomorrow.</strong>"
    : `Your 1:1 is in <strong>${daysUntil} days.</strong>`;

  const topicNote = pendingCount === 0
    ? `<p>No topics have been added yet — now's a great time to queue something up before the meeting.</p>`
    : `<p>You currently have <strong>${pendingCount} topic${pendingCount !== 1 ? "s" : ""}</strong> queued. Anything else to add before you meet?</p>`;

  const body = `
    <p>Hi ${recipientName},</p>
    <p>${urgency} Your 1:1 with <strong>${partnerName}</strong> is scheduled for <strong>${meetingDate}</strong>.</p>
    <div class="item">
      <div class="item-title">📅 ${meetingDate}</div>
      <div class="item-meta">1:1 with ${partnerName}</div>
    </div>
    ${topicNote}
    <p>Add your topics so both of you can walk in prepared for a meaningful conversation.</p>
    <a href="${portalUrl}" class="cta">Open 1:1 Board →</a>
  `;

  return baseEmailTemplate(`1:1 Reminder — ${partnerName}`, body);
}

interface SessionReminder {
  session: { id: string; namId: string; amId: string; meetingDate: string };
  nam: { id: string; name: string; username: string; email?: string | null };
  am: { id: string; name: string; username: string; email?: string | null };
  pendingCount: number;
  daysUntil: number;
  friendlyDate: string;
}

async function getUpcomingSessionReminders(): Promise<SessionReminder[]> {
  const sessions = await storage.getActiveSessionsWithMeetingDate();
  if (sessions.length === 0) return [];

  const allUsers = await storage.getUsers();
  const reminders: SessionReminder[] = [];

  for (const session of sessions) {
    if (!session.meetingDate) continue;
    const daysUntil = getDaysUntil(session.meetingDate);
    if (daysUntil < 0 || daysUntil > 7) continue;

    const nam = allUsers.find(u => u.id === session.namId);
    const am = allUsers.find(u => u.id === session.amId);
    if (!nam || !am) continue;

    const topics = await storage.getTopicsBySession(session.id);
    const pendingCount = topics.filter(t => t.status === "pending").length;

    reminders.push({
      session: { id: session.id, namId: session.namId, amId: session.amId, meetingDate: session.meetingDate },
      nam: nam as any,
      am: am as any,
      pendingCount,
      daysUntil,
      friendlyDate: formatDateFriendly(session.meetingDate),
    });
  }

  return reminders;
}

// Mon / Wed / Fri — send emails
async function sendEmailReminders(): Promise<void> {
  if (!emailEnabled()) {
    logMessage("Email not configured — skipping email reminders");
    return;
  }

  const reminders = await getUpcomingSessionReminders();
  if (reminders.length === 0) {
    logMessage("No upcoming meetings — skipping email reminders");
    return;
  }

  let sent = 0;
  const portalUrl = `${PORTAL_BASE}/one-on-one`;

  for (const { nam, am, pendingCount, daysUntil, friendlyDate } of reminders) {
    const pairs = [
      { user: nam, partnerName: am.name },
      { user: am, partnerName: nam.name },
    ];
    for (const { user, partnerName } of pairs) {
      const email = (user as any).email || (user.username?.includes("@") ? user.username : null);
      if (!email) {
        logMessage(`Skipping ${user.name} — no email configured`);
        continue;
      }
      const html = buildReminderEmail({ recipientName: user.name, partnerName, meetingDate: friendlyDate, pendingCount, portalUrl, daysUntil });
      const subject = `[Growth Chart] 1:1 with ${partnerName} — ${friendlyDate}`;
      const ok = await sendEmail({ to: email, subject, html });
      if (ok) { logMessage(`Email sent to ${user.name} — meeting with ${partnerName} on ${friendlyDate}`); sent++; }
    }
  }

  logMessage(`Email reminders complete — ${sent} sent`);
}

// Tue / Thu — create in-app notifications
async function sendPortalNotifications(): Promise<void> {
  const reminders = await getUpcomingSessionReminders();
  if (reminders.length === 0) {
    logMessage("No upcoming meetings — skipping portal notifications");
    return;
  }

  let created = 0;

  for (const { session, nam, am, pendingCount, daysUntil, friendlyDate } of reminders) {
    const urgencyText = daysUntil === 0 ? "today" : daysUntil === 1 ? "tomorrow" : `in ${daysUntil} days`;
    const topicText = pendingCount === 0
      ? "No topics added yet — add yours before the meeting."
      : `${pendingCount} topic${pendingCount !== 1 ? "s" : ""} queued. Anything to add?`;

    const pairs = [
      { user: nam, partnerName: am.name },
      { user: am, partnerName: nam.name },
    ];

    for (const { user, partnerName } of pairs) {
      await storage.createNotification({
        userId: user.id,
        type: "one_on_one_reminder",
        title: `1:1 with ${partnerName} is ${urgencyText}`,
        body: `${friendlyDate} — ${topicText}`,
        link: "/one-on-one",
        relatedId: session.id,
        read: false,
      });
      logMessage(`Portal notification created for ${user.name} — meeting with ${partnerName} on ${friendlyDate}`);
      created++;
    }
  }

  logMessage(`Portal notifications complete — ${created} created`);
}

export function initOneOnOneReminderScheduler(): void {
  const emailCron  = process.env.ONEONONE_EMAIL_CRON  || "0 9 * * 1,3,5";
  const alertCron  = process.env.ONEONONE_ALERT_CRON  || "0 9 * * 2,4";

  cron.schedule(emailCron, () => {
    sendEmailReminders().catch(err => logMessage(`Error in email reminders: ${err.message}`));
  });

  cron.schedule(alertCron, () => {
    sendPortalNotifications().catch(err => logMessage(`Error in portal notifications: ${err.message}`));
  });

  logMessage(`1:1 reminder scheduler initialized — emails: Mon/Wed/Fri, alerts: Tue/Thu`);
}
