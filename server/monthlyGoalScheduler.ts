import cron from "node-cron";
import { storage } from "./storage";

function logMessage(message: string): void {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [scheduler] ${message}`);
}

export function isFirstBusinessDay(date: Date): boolean {
  const year = date.getFullYear();
  const month = date.getMonth();
  let day = 1;
  let candidate = new Date(year, month, day);
  while (candidate.getDay() === 0 || candidate.getDay() === 6) {
    day++;
    candidate = new Date(year, month, day);
  }
  return date.getDate() === candidate.getDate() &&
    date.getMonth() === candidate.getMonth() &&
    date.getFullYear() === candidate.getFullYear();
}

function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

async function createMonthlyGoalAlerts(): Promise<void> {
  const today = new Date();
  if (!isFirstBusinessDay(today)) return;

  const monthKey = getMonthKey(today);
  const settingKey = "monthly_goal_alert_last_run";
  const lastRun = await storage.getSetting(settingKey);
  if (lastRun === monthKey) {
    logMessage(`Monthly goal alerts already created for ${monthKey}, skipping`);
    return;
  }

  logMessage("First business day of the month — creating goal-setting alerts for NAMs");

  const allUsers = await storage.getUsers();
  const nams = allUsers.filter(u => u.role === "national_account_manager");

  if (nams.length === 0) {
    logMessage("No NAMs found, skipping goal-setting alerts");
    await storage.setSetting(settingKey, monthKey);
    return;
  }

  const todayStr = formatLocalDate(today);

  for (const nam of nams) {
    await storage.createNotification({
      userId: nam.id,
      type: "goal_reminder",
      title: "It's a new month — time to set goals for yourself and your AMs!",
      body: "Start the month strong by setting goals for yourself and your Account Managers.",
      link: "/goals",
      read: false,
    });

    await storage.createTask({
      title: "Set monthly goals for yourself and your AMs",
      notes: "Auto-generated reminder: Review and set goals for the new month.",
      status: "open",
      dueDate: todayStr,
      assignedTo: nam.id,
      assignedBy: nam.id,
      createdAt: new Date().toISOString(),
    });

    logMessage(`Created goal-setting alert and task for NAM: ${nam.name} (${nam.id})`);
  }

  await storage.setSetting(settingKey, monthKey);
  logMessage(`Monthly goal alerts completed for ${monthKey}`);
}

export function initMonthlyGoalScheduler(): void {
  const cronExpression = process.env.MONTHLY_GOAL_CRON || "0 8 * * *";
  cron.schedule(cronExpression, () => {
    createMonthlyGoalAlerts().catch(err => {
      logMessage(`Error in monthly goal scheduler: ${err.message}`);
    });
  });
  logMessage(`Monthly goal-setting scheduler initialized (cron: ${cronExpression})`);

  createMonthlyGoalAlerts().catch(err => {
    logMessage(`Error in startup catch-up goal check: ${err.message}`);
  });
}
