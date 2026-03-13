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

function getNthDayOfWeek(year: number, month: number, dayOfWeek: number, n: number): Date {
  const first = new Date(year, month, 1);
  const firstDow = first.getDay();
  let day = 1 + ((dayOfWeek - firstDow + 7) % 7) + (n - 1) * 7;
  return new Date(year, month, day);
}

function getUSFederalHolidays(year: number): Set<string> {
  const holidays = new Set<string>();
  const fmt = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

  const jan1 = new Date(year, 0, 1);
  if (jan1.getDay() === 6) holidays.add(fmt(new Date(year - 1, 11, 31)));
  else if (jan1.getDay() === 0) holidays.add(fmt(new Date(year, 0, 2)));
  else holidays.add(fmt(jan1));

  holidays.add(fmt(getNthDayOfWeek(year, 0, 1, 3)));

  holidays.add(fmt(getNthDayOfWeek(year, 1, 1, 3)));

  holidays.add(fmt(getNthDayOfWeek(year, 4, 1, 4)));

  const june19 = new Date(year, 5, 19);
  if (june19.getDay() === 6) holidays.add(fmt(new Date(year, 5, 18)));
  else if (june19.getDay() === 0) holidays.add(fmt(new Date(year, 5, 20)));
  else holidays.add(fmt(june19));

  const july4 = new Date(year, 6, 4);
  if (july4.getDay() === 6) holidays.add(fmt(new Date(year, 6, 3)));
  else if (july4.getDay() === 0) holidays.add(fmt(new Date(year, 6, 5)));
  else holidays.add(fmt(july4));

  holidays.add(fmt(getNthDayOfWeek(year, 8, 1, 1)));

  holidays.add(fmt(getNthDayOfWeek(year, 9, 1, 2)));

  const nov11 = new Date(year, 10, 11);
  if (nov11.getDay() === 6) holidays.add(fmt(new Date(year, 10, 10)));
  else if (nov11.getDay() === 0) holidays.add(fmt(new Date(year, 10, 12)));
  else holidays.add(fmt(nov11));

  holidays.add(fmt(getNthDayOfWeek(year, 10, 4, 4)));

  const dec25 = new Date(year, 11, 25);
  if (dec25.getDay() === 6) holidays.add(fmt(new Date(year, 11, 24)));
  else if (dec25.getDay() === 0) holidays.add(fmt(new Date(year, 11, 26)));
  else holidays.add(fmt(dec25));

  return holidays;
}

function isHolidayOrWeekend(date: Date): boolean {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return true;
  const holidays = getUSFederalHolidays(date.getFullYear());
  const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  return holidays.has(key);
}

export function isFirstBusinessDay(date: Date): boolean {
  const year = date.getFullYear();
  const month = date.getMonth();
  let day = 1;
  let candidate = new Date(year, month, day);
  while (isHolidayOrWeekend(candidate)) {
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
