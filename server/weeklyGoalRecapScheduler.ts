import cron from "node-cron";
import { storage } from "./storage";
import { sendEmail, baseEmailTemplate, emailEnabled } from "./emailService";

function logMessage(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [goal-recap] ${message}`);
}

function progressPct(current: number, target: number): number {
  if (target <= 0) return 0;
  return Math.min(100, Math.round((current / target) * 100));
}

function paceLabel(pct: number, expected: number): string {
  const gap = pct - expected;
  if (pct >= 100) return "✅ Goal reached!";
  if (gap >= 5) return `⚡ ${gap}% ahead of pace`;
  if (gap <= -15) return `🔴 ${Math.abs(gap)}% behind pace`;
  if (gap < 0) return `🟡 Slightly behind — push now`;
  return `🟢 On pace`;
}

function formatValue(metric: string, value: number): string {
  if (metric === "margin") return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (metric === "margin_pct") return `${value}%`;
  return value.toLocaleString();
}

function metricLabel(metric: string, customLabel?: string | null): string {
  const labels: Record<string, string> = {
    contacts_added: "New Contacts",
    touchpoints: "Touchpoints",
    meaningful_touchpoints: "Meaningful Conversations",
    load_count: "Load Count",
    loads_booked: "Loads Booked",
    margin: "Margin ($)",
    margin_pct: "Margin %",
    custom: customLabel || "Custom Goal",
  };
  return labels[metric] ?? metric;
}

async function sendWeeklyGoalRecaps(): Promise<void> {
  if (!emailEnabled()) {
    logMessage("Email not configured — skipping weekly goal recap.");
    return;
  }

  logMessage("Running weekly goal recap...");

  const defaultOrg = await storage.getDefaultOrganization();
  if (!defaultOrg) { logMessage("No default organization found, skipping."); return; }

  const allUsers = await storage.getUsers(defaultOrg.id);
  const amUsers = allUsers.filter(u =>
    u.role === "account_manager" || u.role === "national_account_manager" || u.role === "sales"
  );

  const todayStr = new Date().toISOString().slice(0, 10);
  const now = new Date();

  let sent = 0;

  for (const user of amUsers) {
    const email = (user as any).email || user.username;
    if (!email) continue;

    const allGoals = await storage.getGoals({ amId: user.id });
    const activeGoals = allGoals.filter(g => g.startDate <= todayStr && g.endDate >= todayStr);

    if (activeGoals.length === 0) continue;

    const firstName = user.name.split(" ")[0];

    const goalRows = activeGoals.map(goal => {
      const current = parseFloat(goal.currentValue || "0");
      const target = parseFloat(goal.target || "1");
      const pct = progressPct(current, target);

      const goalStart = new Date(goal.startDate);
      const goalEnd = new Date(goal.endDate);
      const totalDays = Math.max(1, (goalEnd.getTime() - goalStart.getTime()) / 86400000);
      const daysPassed = Math.max(0, (now.getTime() - goalStart.getTime()) / 86400000);
      const expectedPct = Math.min(100, Math.round((daysPassed / totalDays) * 100));

      const barWidth = Math.min(pct, 100);
      const barColor = pct >= 100 ? "#16a34a" : pct >= 75 ? "#2563eb" : pct >= 40 ? "#d97706" : "#dc2626";

      return `
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:12px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <div>
              <p style="margin:0;font-size:14px;font-weight:600;color:#111827;">${goal.title || metricLabel(goal.metric, goal.customLabel)}</p>
              <p style="margin:2px 0 0;font-size:12px;color:#6b7280;">${metricLabel(goal.metric, goal.customLabel)} &bull; ${goal.period}</p>
            </div>
            <div style="text-align:right;">
              <p style="margin:0;font-size:18px;font-weight:700;color:${barColor};">${pct}%</p>
              <p style="margin:0;font-size:11px;color:#6b7280;">${formatValue(goal.metric, current)} / ${formatValue(goal.metric, target)}</p>
            </div>
          </div>
          <div style="background:#e5e7eb;border-radius:999px;height:6px;overflow:hidden;margin-bottom:6px;">
            <div style="background:${barColor};height:6px;width:${barWidth}%;border-radius:999px;transition:width 0.3s;"></div>
          </div>
          <p style="margin:0;font-size:12px;color:#6b7280;">${paceLabel(pct, expectedPct)}</p>
        </div>`;
    }).join("");

    const onTrack = activeGoals.filter(g => {
      const pct = progressPct(parseFloat(g.currentValue || "0"), parseFloat(g.target || "1"));
      const goalStart = new Date(g.startDate);
      const goalEnd = new Date(g.endDate);
      const totalDays = Math.max(1, (goalEnd.getTime() - goalStart.getTime()) / 86400000);
      const daysPassed = Math.max(0, (now.getTime() - goalStart.getTime()) / 86400000);
      const expectedPct = Math.min(100, Math.round((daysPassed / totalDays) * 100));
      return pct >= expectedPct - 10;
    });

    const summaryLine = onTrack.length === activeGoals.length
      ? `You're on track with all ${activeGoals.length} active goal${activeGoals.length !== 1 ? "s" : ""}. Keep the momentum going!`
      : `${onTrack.length} of ${activeGoals.length} goals on pace — let's push on the rest this week.`;

    const portalUrl = process.env.APP_URL || "https://sales-org-builder.replit.app";

    const html = baseEmailTemplate(
      `Weekly Goal Recap — ${user.name}`,
      `<p>Good morning, ${firstName}! Here's your weekly goal progress snapshot for Freight DNA.</p>
      <p style="font-size:14px;color:#374151;margin-bottom:16px;">${summaryLine}</p>
      ${goalRows}
      <a class="cta" href="${portalUrl}/goals">View All Goals →</a>`
    );

    const ok = await sendEmail({
      to: email,
      subject: `[Freight DNA] Your weekly goal recap — ${onTrack.length}/${activeGoals.length} on pace`,
      html,
    });

    if (ok) {
      sent++;
      logMessage(`Recap sent to ${user.name} (${activeGoals.length} active goals)`);
    }
  }

  if (sent === 0) {
    logMessage("No goal recaps sent — no active goals or no email configured.");
  } else {
    logMessage(`Weekly goal recap complete — ${sent} rep(s) notified.`);
  }
}

export function initWeeklyGoalRecapScheduler(): void {
  const cronExpression = process.env.WEEKLY_GOAL_RECAP_CRON || "0 8 * * 1";
  cron.schedule(cronExpression, () => {
    sendWeeklyGoalRecaps().catch(err => logMessage(`Error in weekly goal recap scheduler: ${err.message}`));
  });
  logMessage(`Weekly goal recap scheduler initialized (cron: ${cronExpression})`);
}
